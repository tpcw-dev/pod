import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Operation, Task } from "../domain/ledger.ts";
import {
  refuse,
  type Outcome,
  type Refusal,
  type Refused,
} from "../domain/outcome.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { runBlocked } from "../ledger/run-blocked.ts";
import { recordManifest } from "../manifest/record.ts";
import {
  gitStatusReference,
  ManifestReference,
} from "../manifest/references.ts";
import { renderTaskView } from "../manifest/task-view.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { replayed } from "./dispatch.ts";
import {
  recordReceipt,
  type DispatchResult,
  type LaunchArgs,
  type LaunchRequest,
} from "./launch-record.ts";
import { freeSlots, onHost, openLaunches } from "./quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "./seats.ts";

export interface RetryInput {
  dispatch: string;
  generation: number;
  opKey: string | null;
  host: string;
  capacity: number;
  gitStatus: string;
  command: (opKey: string) => string;
  now: () => Date;
}

export interface RetryResult extends DispatchResult {
  retry_of: string;
  task_view: string;
}

const Placement = z.looseObject({
  agent: z.string().min(1).optional().catch(undefined),
  model: z.string().min(1).optional().catch(undefined),
  effort: z.string().min(1).optional().catch(undefined),
  worktree: z.string().optional().catch(undefined),
});

const References = z.array(ManifestReference);

export async function retryPlan(
  db: Repo,
  dispatchId: string,
  host: string,
): Promise<{ worktreePath: string } | Refused> {
  const dispatch = await db.getDispatch(dispatchId);
  if (dispatch === null)
    return refuse("task_not_ready", `no Dispatch ${dispatchId}`, ["pod brief"]);
  const task =
    dispatch.task_id === null ? null : await db.getTask(dispatch.task_id);
  const superseded = task === null ? null : await supersededRefusal(db, task);
  if (superseded !== null) return superseded;
  const worktree = Placement.catch({}).parse(
    dispatch.requested_launch,
  ).worktree;
  const id = worktree?.startsWith("id:") === true ? worktree.slice(3) : null;
  const split = id?.indexOf("::") ?? -1;
  if (id === null || split < 0)
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatchId} has no recorded worktree`,
      [`requested_launch.worktree is ${worktree ?? "missing"}`],
    );
  const start = await db.dispatchEvent(dispatchId, "start");
  if (start?.host !== host)
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatchId} started on host ${start?.host ?? "unknown"}, not ${host}`,
      ["run pod retry on the host that started the Dispatch"],
    );
  return { worktreePath: id.slice(split + 2) };
}

async function supersededRefusal(
  db: Repo,
  task: Task,
): Promise<Refused | null> {
  if (task.state !== "superseded") return null;
  const replacement = (await db.listTasks(task.run_id)).find(
    (row) => row.rework_of === task.task_id,
  );
  return refuse("task_not_ready", `Task ${task.task_id} is superseded`, [
    replacement === undefined
      ? "pod brief"
      : `pod dispatch --task ${replacement.task_id}`,
  ]);
}

export async function supersededWorktree(
  db: Repo,
  taskId: string,
  host: string,
): Promise<string | null> {
  const task = await db.getTask(taskId);
  const previous =
    task?.rework_of == null ? null : await db.getTask(task.rework_of);
  if (previous?.state !== "superseded") return null;
  const last = (await db.listDispatches(previous.run_id))
    .filter((row) => row.task_id === previous.task_id)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  if (last === undefined) return null;
  const plan = await retryPlan(db, last.dispatch_id, host);
  return "ok" in plan ? null : plan.worktreePath;
}

function launchFor(
  dispatch: Dispatch,
  seat: Seat | undefined,
): LaunchArgs | null {
  const placed = Placement.catch({}).parse(dispatch.requested_launch);
  const agent = placed.agent ?? seat?.runtime;
  const model = placed.model ?? seat?.model;
  const effort = placed.effort ?? seat?.effort;
  if (agent === undefined || placed.worktree === undefined) return null;
  return {
    agent,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    worktree: placed.worktree,
    retryOf: dispatch.dispatch_id,
  };
}

function taskViewOf(references: unknown): string {
  const rows = References.parse(references);
  const git = rows.find((row) => row.source === "git_status");
  return renderTaskView({
    ...(git === undefined ? {} : { gitStatus: git.excerpt }),
    policies: [],
    reserved: [],
    decisions: [],
    roadmap: [],
    sources: rows
      .filter((row) => row !== git)
      .map((row) => ({
        title: row.source,
        body: row.excerpt,
        routing: `pod brief ${row.source}`,
      })),
  }).text;
}

type Gate =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "existing"; operation: Operation }
  | {
      kind: "launch";
      manifestId: string;
      references: unknown;
      launch: LaunchArgs;
    };

export async function retry(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: RetryInput,
): Promise<Outcome<RetryResult>> {
  const plan = await retryPlan(db, input.dispatch, input.host);
  if ("ok" in plan) return plan;
  const original = await db.getDispatch(input.dispatch);
  const task =
    original?.task_id == null ? null : await db.getTask(original.task_id);
  const snapshot = task === null ? null : await db.getSnapshot(task.run_id);
  const crew =
    snapshot === null ? null : await db.getRevision(snapshot.crew_revision_id);
  if (original === null || task === null || crew === null)
    return refuse(
      "task_not_ready",
      `Dispatch ${input.dispatch} lost its Task or crew`,
      ["pod brief"],
    );
  const superseded = await supersededRefusal(db, task);
  if (superseded !== null) return superseded;
  let seats: Seat[];
  try {
    seats = readSeats(crew.value);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    return refuse("schema_invalid", error.message, [error.path]);
  }
  const seat = seats.find((item) => item.id === original.seat);
  const { version } = await orca.version();
  const attempts = (await db.listDispatches(task.run_id)).filter(
    (row) => row.task_id === task.task_id,
  ).length;
  const opKey =
    input.opKey ??
    derivedOpKey("retry", {
      run_id: task.run_id,
      task_id: task.task_id,
      seat: original.seat,
      attempt: String(attempts + 1),
    });
  const request: LaunchRequest = {
    task_id: task.task_id,
    seat: original.seat,
    host: input.host,
    retry_of: original.dispatch_id,
  };
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
          intent: "retry",
          owner_generation: input.generation,
          at: now,
          result_ref: Json.parse({ request }),
        });
        await tx.moveOperation(
          opKey,
          "refused",
          Json.parse({ request, ...found }),
          now,
        );
      }
      return { kind: "refused", refusal: found };
    };
    if (input.generation !== run.owner_generation)
      return record({
        code: "owner_generation_stale",
        message: `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
        nextSteps: [
          `pod takeover story:${run.story_external_id} if this session should own the Run`,
        ],
      });
    if (existing !== null) return { kind: "existing", operation: existing };
    if (await drainInForce(tx, run.run_id))
      return record({
        code: "drained",
        message: `a drain is in force on Run ${run.run_id}`,
        nextSteps: [
          "pod check",
          "pod release",
          "this refusal is recorded under its op key; pass a new --op-key once the drain ends",
        ],
      });
    const siblings = (await tx.listDispatches(run.run_id)).filter(
      (row) => row.task_id === current.task_id,
    );
    const latest = siblings.every(
      (row) => row.created_at.getTime() <= original.created_at.getTime(),
    );
    const blocked = await runBlocked(tx, run.run_id);
    const launches = await openLaunches(tx);
    const inFlight = launches.filter(
      (row) => row.request?.task_id === current.task_id,
    );
    if (
      current.state !== "blocked" ||
      !latest ||
      run.state !== "active" ||
      blocked !== null ||
      inFlight.length > 0
    )
      return record({
        code: "task_not_ready",
        message: `Task ${current.task_id} is not ready to retry Dispatch ${original.dispatch_id}`,
        nextSteps: [
          `Task state ${current.state}`,
          `Run state ${run.state}`,
          ...(latest
            ? []
            : [
                `Dispatch ${original.dispatch_id} is not the Task's latest Dispatch`,
              ]),
          ...inFlight.map(
            (row) =>
              `launch ${row.op_key} (${row.intent}) is ${row.status} for Task ${current.task_id}`,
          ),
          ...(blocked === null
            ? []
            : [`Run blocked by a ${blocked.type} event`]),
        ],
      });
    const reservations = onHost(launches, input.host);
    const slots = freeSlots(
      input.capacity,
      await tx.hostActivities(input.host),
      reservations,
    );
    if (slots < 1)
      return record({
        code: "quota_exhausted",
        message: `no free slot on host ${input.host}`,
        nextSteps: [
          ...reservations.map(
            (row) => `reservation ${row.op_key} is ${row.status}`,
          ),
          "running Dispatches on this host hold the rest",
          "pod check --wait",
          "this refusal is recorded under its op key; pass a new --op-key once a slot frees",
        ],
      });
    const launch = launchFor(original, seat);
    if (launch === null)
      return record({
        code: "role_unfilled",
        message: `Seat ${original.seat} is not in the pinned crew and Dispatch ${original.dispatch_id} names no agent`,
        nextSteps: [`role ${current.role}`],
      });
    const parent =
      original.manifest_id === null
        ? null
        : await tx.getManifest(original.manifest_id);
    const references = [
      ...References.parse(parent?.references ?? []).filter(
        (reference) => reference.source !== "git_status",
      ),
      gitStatusReference(input.gitStatus, now),
    ];
    const { manifest } = await recordManifest(tx, {
      run_id: run.run_id,
      task_id: current.task_id,
      decision_id: null,
      parent_id: parent?.id ?? null,
      created_at: now,
      references,
    });
    await tx.insertOperation({
      op_key: opKey,
      intent: "retry",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({ request, launch, manifest_id: manifest.id }),
    });
    return {
      kind: "launch",
      manifestId: manifest.id,
      references: manifest.references,
      launch,
    };
  });

  const finish = (done: DispatchResult, references: unknown): RetryResult => ({
    ...done,
    retry_of: original.dispatch_id,
    task_view: taskViewOf(references),
  });

  if (gate.kind === "refused") return { ok: false, refusal: gate.refusal };
  if (gate.kind === "existing") {
    const again = await replayed(gate.operation, "retry", {
      orca,
      log,
      runId: task.run_id,
      request,
      command: input.command(opKey),
      opKey,
      version,
    });
    if (!again.ok) return again;
    const manifest = await db.getManifest(again.result.manifest_id);
    return { ...again, result: finish(again.result, manifest?.references) };
  }

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
    verb: "retry",
    at: input.now(),
    receipt,
  });
  if (recorded.kind === "started")
    return {
      ok: true,
      result: finish(recorded.done, gate.references),
      opKey,
      orca: version,
    };
  if (recorded.kind === "failed")
    return refuse(
      "failed",
      `worker-start --retry-of ${original.dispatch_id} failed`,
      [
        ...(receipt.result?.lastError == null
          ? []
          : [receipt.result.lastError]),
        "pod check",
      ],
    );
  return refuse(
    "launch_unknown",
    `worker-start --retry-of ${original.dispatch_id} has no known outcome`,
    [input.command(opKey), "pod check"],
  );
}
