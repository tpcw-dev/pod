import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Operation, Run, Task } from "../domain/ledger.ts";
import {
  refuse,
  RefusalCode,
  type Outcome,
  type Refusal,
} from "../domain/outcome.ts";
import { stopOnOpen } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { runBlocked } from "../ledger/run-blocked.ts";
import { recordManifest } from "../manifest/record.ts";
import {
  revisionReference,
  runReference,
  storyReference,
  taskReference,
} from "../manifest/references.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  recordReceipt,
  type DispatchResult,
  type LaunchArgs,
} from "./launch-record.ts";
import { drainRefusal, slotRefusal } from "./launch-gate.ts";
import { openLaunches } from "./quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "./seats.ts";

export interface DispatchInput {
  task: string;
  seat: string;
  generation: number;
  opKey: string | null;
  host: string;
  capacity: number;
  command: (opKey: string) => string;
  now: () => Date;
}

export type { DispatchResult } from "./launch-record.ts";

const satisfied = ["passed", "done"];

const Recorded = z.looseObject({
  request: z.looseObject({ task_id: z.string(), seat: z.string() }),
  result: z.looseObject({}).optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

type Gate =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "existing"; operation: Operation }
  | { kind: "launch"; manifestId: string; launch: LaunchArgs };

interface Checked {
  run: Run;
  task: Task;
  seat: Seat | undefined;
}

async function precondition(
  tx: Repo,
  input: DispatchInput,
  checked: Checked,
): Promise<{ refusal: Refusal } | { seat: Seat }> {
  const { run, task, seat } = checked;
  const drained = await drainRefusal(tx, run.run_id);
  if (drained !== null) return { refusal: drained };
  const unmet: string[] = [];
  for (const dep of z.array(z.string()).parse(task.deps)) {
    const row = await tx.getTask(dep);
    if (row === null || !satisfied.includes(row.state))
      unmet.push(`dependency ${dep} is ${row?.state ?? "missing"}`);
  }
  const blocked = await runBlocked(tx, run.run_id);
  const launches = await openLaunches(tx);
  const inFlight = launches.filter(
    (row) => row.request?.task_id === task.task_id,
  );
  if (
    task.state !== "ready" ||
    unmet.length > 0 ||
    inFlight.length > 0 ||
    run.state !== "active" ||
    blocked !== null
  )
    return stopWith(
      "task_not_ready",
      `Task ${task.task_id} is not ready to dispatch`,
      [
        `Task state ${task.state}`,
        `Run state ${run.state}`,
        ...unmet,
        ...inFlight.map(
          (row) =>
            `launch ${row.op_key} (${row.intent}) is ${row.status} for Task ${task.task_id}`,
        ),
        ...(blocked === null ? [] : [`Run blocked by a ${blocked.type} event`]),
      ],
    );
  const full = await slotRefusal(tx, input.host, input.capacity, launches);
  if (full !== null) return { refusal: full };
  if (
    seat === undefined ||
    !seat.roles.includes(task.role) ||
    (seat.host !== undefined && seat.host !== input.host)
  )
    return stopWith(
      "role_unfilled",
      `Seat ${input.seat} cannot fill role ${task.role} on host ${input.host}`,
      [
        `role ${task.role}`,
        "pod config apply crew.yaml with a Seat that fills it",
      ],
    );
  if (task.role === "reviewer") {
    const held = (await tx.listDispatches(run.run_id)).filter(
      (row) => row.seat === input.seat && row.role === "developer",
    );
    if (held.length > 0)
      return stopWith(
        "reviewer_not_independent",
        `Seat ${input.seat} holds a developer Dispatch in Run ${run.run_id}`,
        [
          `Seat ${input.seat}`,
          ...held.map((row) => `Dispatch ${row.dispatch_id}`),
        ],
      );
  }
  return { seat };
}

function stopWith(
  code: RefusalCode,
  message: string,
  nextSteps: string[],
): { refusal: Refusal } {
  return { refusal: refusal(code, message, nextSteps) };
}

function refusal(
  code: RefusalCode,
  message: string,
  nextSteps: string[],
): Refusal {
  return { code, message, nextSteps };
}

export function seatLaunch(seat: Seat): LaunchArgs {
  return {
    agent: seat.runtime,
    ...(seat.model === undefined ? {} : { model: seat.model }),
    ...(seat.effort === undefined ? {} : { effort: seat.effort }),
    worktree: "current",
  };
}

export async function dispatch(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: DispatchInput,
): Promise<Outcome<DispatchResult>> {
  const task = await db.getTask(input.task);
  if (task === null)
    return refuse("task_not_ready", `no Task ${input.task}`, ["pod brief"]);
  const snapshot = await db.getSnapshot(task.run_id);
  const crew =
    snapshot === null ? null : await db.getRevision(snapshot.crew_revision_id);
  if (snapshot === null || crew === null)
    return refuse(
      "task_not_ready",
      `Run ${task.run_id} has no pinned Snapshot`,
      ["pod brief"],
    );
  let seats: Seat[];
  try {
    seats = readSeats(crew.value);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    return refuse("schema_invalid", error.message, [error.path]);
  }
  const seat = seats.find((item) => item.id === input.seat);
  const { version } = await orca.version();
  const opKey =
    input.opKey ??
    derivedOpKey("dispatch", {
      run_id: task.run_id,
      task_id: task.task_id,
      seat: input.seat,
      attempt: "1",
    });
  const request = { task_id: task.task_id, seat: input.seat, host: input.host };
  const now = input.now();

  const gate = await db.transaction(async (tx): Promise<Gate> => {
    await tx.lockQuota(input.host);
    const run = await tx.getRun(task.run_id);
    const current = await tx.getTask(task.task_id);
    if (run === null || current === null)
      throw new Error(`Run ${task.run_id} vanished`);
    const existing = await tx.getOperation(opKey);
    const record = async (found: Refusal): Promise<Gate> => {
      if (existing === null) {
        await tx.insertOperation({
          op_key: opKey,
          intent: "dispatch",
          owner_generation: input.generation,
          at: now,
          result_ref: { request },
        });
        await tx.moveOperation(opKey, "refused", { request, ...found }, now);
      }
      return { kind: "refused", refusal: found };
    };
    if (input.generation !== run.owner_generation)
      return record(
        refusal(
          "owner_generation_stale",
          `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
          [
            `pod takeover story:${run.story_external_id} if this session should own the Run`,
          ],
        ),
      );
    if (existing !== null) return { kind: "existing", operation: existing };
    const found = await precondition(tx, input, { run, task: current, seat });
    if ("refusal" in found) return record(found.refusal);
    const launch = seatLaunch(found.seat);
    const story = await tx.getStory(run.story_provider, run.story_external_id);
    const process = await tx.getRevision(snapshot.process_revision_id);
    const policy = await tx.getRevision(snapshot.policy_revision_id);
    if (story === null || process === null || policy === null)
      throw new Error(`Run ${run.run_id} lost its Story or pinned Revisions`);
    const { manifest } = await recordManifest(tx, {
      run_id: run.run_id,
      task_id: current.task_id,
      decision_id: null,
      parent_id: null,
      created_at: now,
      references: [
        storyReference(story),
        runReference(run),
        taskReference(current),
        revisionReference(crew),
        revisionReference(process),
        revisionReference(policy),
      ],
    });
    await tx.insertOperation({
      op_key: opKey,
      intent: "dispatch",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({ request, launch, manifest_id: manifest.id }),
    });
    return { kind: "launch", manifestId: manifest.id, launch };
  });

  if (gate.kind === "refused") return { ok: false, refusal: gate.refusal };
  if (gate.kind === "existing")
    return replayed(gate.operation, "dispatch", {
      orca,
      log,
      runId: task.run_id,
      request,
      command: input.command(opKey),
      opKey,
      version,
    });

  const { launch } = gate;
  log.at({ run_id: task.run_id, task_id: task.task_id, op_key: opKey });
  const receipt = await orca.workerStart({
    task: task.task_id,
    run: task.run_id,
    ...launch,
  });
  const recorded = await recordReceipt(db, {
    opKey,
    request,
    launch,
    task,
    manifestId: gate.manifestId,
    generation: input.generation,
    verb: "dispatch",
    at: input.now(),
    receipt,
  });
  if (recorded.kind === "started")
    return { ok: true, result: recorded.done, opKey, orca: version };
  if (recorded.kind === "failed")
    return refuse("failed", `worker-start for Task ${task.task_id} failed`, [
      ...(receipt.result?.lastError == null ? [] : [receipt.result.lastError]),
      "pod check",
    ]);
  return refuse(
    "launch_unknown",
    `worker-start for Task ${task.task_id} has no known outcome`,
    [input.command(opKey), "pod check"],
  );
}

export interface Replay {
  orca: OrcaPort;
  log: ReceiptLog;
  runId: string;
  request: { task_id: string; seat: string; host: string };
  command: string;
  opKey: string;
  version: string;
}

export async function replayed(
  operation: Operation,
  intent: "dispatch" | "retry",
  { orca, log, runId, request, command, opKey, version }: Replay,
): Promise<Outcome<DispatchResult>> {
  const ref = Recorded.safeParse(operation.result_ref);
  if (
    operation.intent !== intent ||
    !ref.success ||
    ref.data.request.task_id !== request.task_id ||
    ref.data.request.seat !== request.seat
  )
    return refuse(
      "duplicate_op",
      `op key ${opKey} belongs to another intent or request`,
      ["pass a new --op-key, with retry_of for a retry"],
    );
  if (operation.status === "unknown" || operation.status === "pending")
    return stopOnOpen(
      orca,
      log,
      { run_id: runId, task_id: request.task_id, op_key: opKey },
      operation,
      command,
    );
  if (operation.status === "refused")
    return refuse(
      ref.data.code ?? "failed",
      ref.data.message ?? `op key ${opKey} was refused`,
      ref.data.nextSteps ?? [],
    );
  const done = z
    .object({
      dispatch_id: z.string(),
      task_id: z.string(),
      run_id: z.string(),
      seat: z.string(),
      manifest_id: z.string(),
      model_attribution: z.enum(["receipt", "unknown"]),
      terminal_handle: z.string().nullable(),
      owner_generation: z.int(),
    })
    .safeParse(ref.data.result);
  if (!done.success)
    return refuse(
      "failed",
      `worker-start under op key ${opKey} failed before`,
      ["pod check"],
    );
  return { ok: true, result: done.data, opKey, orca: version };
}
