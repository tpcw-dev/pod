import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Operation, Run, Task } from "../domain/ledger.ts";
import {
  refuse,
  RefusalCode,
  type Outcome,
  type Refusal,
} from "../domain/outcome.ts";
import { launchOutcome, stopOnOpen } from "../ledger/launch.ts";
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
import type { OrcaPort, WorkerStartResult } from "../ports/orca.ts";
import { freeSlots, launchIntents } from "./quota.ts";
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

export interface DispatchResult {
  dispatch_id: string;
  task_id: string;
  run_id: string;
  seat: string;
  manifest_id: string;
  model_attribution: "receipt" | "unknown";
  terminal_handle: string | null;
  owner_generation: number;
}

const satisfied = ["passed", "done"];

const LaunchRequest = z.looseObject({
  request: z.looseObject({
    task_id: z.string().optional(),
    host: z.string().optional(),
  }),
});

const DrainEnded = z.looseObject({ ended: z.literal(true) });

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
  | { kind: "launch"; manifestId: string; seat: Seat };

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
  const drain = await tx.latestEvent(run.run_id, "drain");
  if (drain !== null && !DrainEnded.safeParse(drain.payload).success)
    return stopWith("drained", `a drain is in force on Run ${run.run_id}`, [
      "pod check",
      "pod release",
      "this refusal is recorded under its op key; pass a new --op-key once the drain ends",
    ]);
  const unmet: string[] = [];
  for (const dep of z.array(z.string()).parse(task.deps)) {
    const row = await tx.getTask(dep);
    if (row === null || !satisfied.includes(row.state))
      unmet.push(`dependency ${dep} is ${row?.state ?? "missing"}`);
  }
  const blocked = await runBlocked(tx, run.run_id);
  const launches = (await tx.launchReservations(launchIntents)).map((row) => ({
    ...row,
    request: LaunchRequest.safeParse(row.result_ref).data?.request ?? null,
  }));
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
  const reservations = launches.filter(
    (row) => (row.request?.host ?? input.host) === input.host,
  );
  const slots = freeSlots(
    input.capacity,
    await tx.hostActivities(input.host),
    reservations,
  );
  if (slots < 1)
    return stopWith("quota_exhausted", `no free slot on host ${input.host}`, [
      ...reservations.map(
        (row) => `reservation ${row.op_key} is ${row.status}`,
      ),
      "running Dispatches on this host hold the rest",
      "pod check --wait",
      "this refusal is recorded under its op key; pass a new --op-key once a slot frees",
    ]);
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

function attribution(result: WorkerStartResult): "receipt" | "unknown" {
  const model =
    result.launch?.effective?.model ?? result.launch?.requested?.model;
  return typeof model === "string" && model !== "" ? "receipt" : "unknown";
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
    await tx.insertOperation({
      op_key: opKey,
      intent: "dispatch",
      owner_generation: input.generation,
      at: now,
      result_ref: { request },
    });
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
    return { kind: "launch", manifestId: manifest.id, seat: found.seat };
  });

  if (gate.kind === "refused") return { ok: false, refusal: gate.refusal };
  if (gate.kind === "existing")
    return replayed(gate.operation, {
      orca,
      log,
      runId: task.run_id,
      request,
      input,
      opKey,
      version,
    });

  const { seat: chosen } = gate;
  log.at({ run_id: task.run_id, task_id: task.task_id, op_key: opKey });
  const launch = {
    agent: chosen.runtime,
    ...(chosen.model === undefined ? {} : { model: chosen.model }),
    ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
    worktree: "current",
  };
  const receipt = await orca.workerStart({
    task: task.task_id,
    run: task.run_id,
    ...launch,
  });
  const outcome = launchOutcome(receipt);
  const at = input.now();
  const result = receipt.result;

  if (
    outcome.kind === "ok" &&
    result !== null &&
    typeof result.dispatchId === "string"
  ) {
    const dispatchId = result.dispatchId;
    const done: DispatchResult = {
      dispatch_id: dispatchId,
      task_id: task.task_id,
      run_id: task.run_id,
      seat: input.seat,
      manifest_id: gate.manifestId,
      model_attribution: attribution(result),
      terminal_handle: result.terminalHandle ?? null,
      owner_generation: input.generation,
    };
    await db.transaction(async (tx) => {
      await tx.moveOperation(
        opKey,
        "done",
        Json.parse({ request, manifest_id: gate.manifestId, result: done }),
        at,
      );
      await tx.insertDispatch({
        dispatch_id: dispatchId,
        task_id: task.task_id,
        run_id: task.run_id,
        seat: input.seat,
        role: task.role,
        requested_launch: Json.parse(result.launch?.requested ?? launch),
        effective_launch: Json.parse(result.launch?.effective ?? null),
        model_attribution: done.model_attribution,
        retry_of: null,
        op_key: opKey,
        settlement: "open",
        terminal_handle: done.terminal_handle,
        created_at: at,
        settled_at: null,
        activity: "running",
        manifest_id: gate.manifestId,
      });
      await tx.setTaskState(task.task_id, "dispatched");
      await tx.appendEvent({
        type: "start",
        ts: at,
        host: input.host,
        run_id: task.run_id,
        task_id: task.task_id,
        dispatch_id: dispatchId,
        op_key: opKey,
        payload: {
          seat: input.seat,
          role: task.role,
          manifest_id: gate.manifestId,
        },
        source: { kind: "command", verb: "dispatch" },
      });
    });
    return { ok: true, result: done, opKey, orca: version };
  }

  if (outcome.kind === "failed") {
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "failed", raw: receipt.raw ?? null }),
      at,
    );
    return refuse("failed", `worker-start for Task ${task.task_id} failed`, [
      ...(result?.lastError == null ? [] : [result.lastError]),
      "pod check",
    ]);
  }

  const requestId = outcome.kind === "unknown" ? outcome.requestId : null;
  await db.transaction(async (tx) => {
    await tx.moveOperation(
      opKey,
      "unknown",
      { request, requestId, manifest_id: gate.manifestId },
      at,
    );
    await tx.setTaskState(task.task_id, "hold");
    await tx.appendEvent({
      type: "hold",
      ts: at,
      host: input.host,
      run_id: task.run_id,
      task_id: task.task_id,
      dispatch_id: null,
      op_key: opKey,
      payload: { reason: "launch_unknown", op_key: opKey },
      source: { kind: "command", verb: "dispatch" },
    });
  });
  return refuse(
    "launch_unknown",
    `worker-start for Task ${task.task_id} has no known outcome`,
    [input.command(opKey), "pod check"],
  );
}

interface Replay {
  orca: OrcaPort;
  log: ReceiptLog;
  runId: string;
  request: { task_id: string; seat: string; host: string };
  input: DispatchInput;
  opKey: string;
  version: string;
}

async function replayed(
  operation: Operation,
  { orca, log, runId, request, input, opKey, version }: Replay,
): Promise<Outcome<DispatchResult>> {
  const ref = Recorded.safeParse(operation.result_ref);
  if (
    operation.intent !== "dispatch" ||
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
      input.command(opKey),
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
