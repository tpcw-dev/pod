import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Operation, Run, Task } from "../domain/ledger.ts";
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
import { stepMethod } from "../process/method.ts";
import { replayed } from "./dispatch.ts";
import {
  recordReceipt,
  type DispatchResult,
  type LaunchArgs,
  type LaunchRequest,
} from "./launch-record.ts";
import { slotRefusal } from "./launch-gate.ts";
import { openLaunches } from "./quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "./seats.ts";

export interface RetryInput {
  dispatch: string;
  generation: number;
  opKey: string | null;
  host: string;
  capacity: number | null;
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

/**
 * How `pod retry` starts the Task: `retry_of` sends `--retry-of`, and `fresh`
 * sends a plain start, because the worker runtime leaves the Task ready after
 * it abandons a worker whose terminal is gone and refuses `--retry-of` there.
 */
export type StartMode = "retry_of" | "fresh";

const StopPayload = z.looseObject({ worker_state: z.unknown() });

async function startMode(db: Repo, dispatchId: string): Promise<StartMode> {
  const stop = await db.dispatchEvent(dispatchId, "stop");
  const payload = StopPayload.safeParse(stop?.payload);
  return payload.success && payload.data.worker_state === "abandoned"
    ? "fresh"
    : "retry_of";
}

/** The op key `pod retry` derives for the Task's next attempt. */
export function retryOpKey(
  task: Pick<Task, "run_id" | "task_id">,
  seat: string,
  dispatches: readonly Pick<Dispatch, "task_id">[],
): string {
  const attempts = dispatches.filter(
    (row) => row.task_id === task.task_id,
  ).length;
  return derivedOpKey("retry", {
    run_id: task.run_id,
    task_id: task.task_id,
    seat,
    attempt: String(attempts + 1),
  });
}

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
  return recordedWorktree(db, dispatch, host);
}

function placedWorktree(dispatch: Dispatch): string | undefined {
  return Placement.catch({}).parse(dispatch.requested_launch).worktree;
}

export function dispatchSelector(dispatch: Dispatch): string | null {
  return dispatchWorktree(dispatch) === null
    ? null
    : (placedWorktree(dispatch) ?? null);
}

export function dispatchWorktree(dispatch: Dispatch): string | null {
  const worktree = placedWorktree(dispatch);
  const id = worktree?.startsWith("id:") === true ? worktree.slice(3) : null;
  const split = id?.indexOf("::") ?? -1;
  return id === null || split < 0 ? null : id.slice(split + 2);
}

async function recordedWorktree(
  db: Repo,
  dispatch: Dispatch,
  host: string,
): Promise<{ worktreePath: string } | Refused> {
  const dispatchId = dispatch.dispatch_id;
  const worktreePath = dispatchWorktree(dispatch);
  if (worktreePath === null)
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatchId} has no recorded worktree`,
      [`requested_launch.worktree is ${placedWorktree(dispatch) ?? "missing"}`],
    );
  const start = await db.dispatchEvent(dispatchId, "start");
  if (start?.host !== host)
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatchId} started on host ${start?.host ?? "unknown"}, not ${host}`,
      ["run pod retry on the host that started the Dispatch"],
    );
  return { worktreePath };
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
  const plan = await recordedWorktree(db, last, host);
  return "ok" in plan ? null : plan.worktreePath;
}

function launchFor(
  dispatch: Dispatch,
  seat: Seat | undefined,
  start: StartMode,
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
    ...(start === "retry_of" ? { retryOf: dispatch.dispatch_id } : {}),
  };
}

function taskViewOf(references: unknown, method: string | null): string {
  const rows = References.parse(references);
  const git = rows.find((row) => row.source === "git_status");
  return renderTaskView({
    ...(git === undefined ? {} : { gitStatus: git.excerpt }),
    ...(method === null ? {} : { method }),
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

export interface RetryGateInput {
  run: Run;
  task: Task;
  original: Dispatch;
  seat: Seat | undefined;
  start: StartMode;
  host: string;
  capacity: number | null;
}

export type RetryGate =
  | { ok: true; launch: LaunchArgs }
  | { ok: false; refusal: Refusal };

function refused(refusal: Refusal): RetryGate {
  return { ok: false, refusal };
}

export async function retryGate(
  tx: Repo,
  gate: RetryGateInput,
): Promise<RetryGate> {
  const { run, task, original, seat } = gate;
  if (await drainInForce(tx, run.run_id))
    return refused({
      code: "drained",
      message: `a drain is in force on Run ${run.run_id}`,
      nextSteps: [
        "pod check",
        "pod release",
        "this refusal is recorded under its op key; pass a new --op-key once the drain ends",
      ],
    });
  const siblings = (await tx.listDispatches(run.run_id)).filter(
    (row) => row.task_id === task.task_id,
  );
  const latest = siblings.every(
    (row) => row.created_at.getTime() <= original.created_at.getTime(),
  );
  const blocked = await runBlocked(tx, run.run_id);
  const launches = await openLaunches(tx);
  const inFlight = launches.filter(
    (row) => row.request?.task_id === task.task_id,
  );
  if (
    task.state !== "blocked" ||
    !latest ||
    run.state !== "active" ||
    blocked !== null ||
    inFlight.length > 0
  )
    return refused({
      code: "task_not_ready",
      message: `Task ${task.task_id} is not ready to retry Dispatch ${original.dispatch_id}`,
      nextSteps: [
        `Task state ${task.state}`,
        `Run state ${run.state}`,
        ...(latest
          ? []
          : [
              `Dispatch ${original.dispatch_id} is not the Task's latest Dispatch`,
            ]),
        ...inFlight.map(
          (row) =>
            `launch ${row.op_key} (${row.intent}) is ${row.status} for Task ${task.task_id}`,
        ),
        ...(blocked === null
          ? []
          : [`Run blocked by a ${blocked.type} event`]),
      ],
    });
  const full = await slotRefusal(tx, gate.host, gate.capacity, launches);
  if (full !== null) return refused(full);
  const launch = launchFor(original, seat, gate.start);
  if (launch === null)
    return refused({
      code: "role_unfilled",
      message: `Seat ${original.seat} is not in the pinned crew and Dispatch ${original.dispatch_id} names no agent`,
      nextSteps: [`role ${task.role}`],
    });
  return { ok: true, launch };
}

type Gate =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "existing"; operation: Operation }
  | {
      kind: "launch";
      manifestId: string;
      references: unknown;
      launch: LaunchArgs;
      from: string;
    };

interface RetrySubject {
  original: Dispatch;
  task: Task;
  seat: Seat | undefined;
  start: StartMode;
}

async function retrySubject(
  db: Repo,
  dispatchId: string,
): Promise<RetrySubject | Refused> {
  const original = await db.getDispatch(dispatchId);
  const task =
    original?.task_id == null ? null : await db.getTask(original.task_id);
  const snapshot = task === null ? null : await db.getSnapshot(task.run_id);
  const crew =
    snapshot === null ? null : await db.getRevision(snapshot.crew_revision_id);
  if (original === null || task === null || crew === null)
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatchId} lost its Task or crew`,
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
  return {
    original,
    task,
    seat: seats.find((item) => item.id === original.seat),
    start: await startMode(db, original.dispatch_id),
  };
}

/**
 * Answers whether `pod retry` of a Dispatch would launch now, and writes
 * nothing, so a refusal that can clear is not stored under an op key.
 */
export async function retryReady(
  db: Db,
  dispatchId: string,
  host: string,
  capacity: number | null,
): Promise<{ worktreePath: string } | Refused> {
  const plan = await retryPlan(db, dispatchId, host);
  if ("ok" in plan) return plan;
  const subject = await retrySubject(db, dispatchId);
  if ("ok" in subject) return subject;
  const gate = await db.transaction(async (tx) => {
    const run = await tx.getRun(subject.task.run_id);
    const task = await tx.getTask(subject.task.task_id);
    if (run === null || task === null)
      throw new Error(`Run ${subject.task.run_id} vanished`);
    return retryGate(tx, {
      run,
      task,
      original: subject.original,
      seat: subject.seat,
      start: "retry_of",
      host,
      capacity,
    });
  });
  return gate.ok ? plan : { ok: false, refusal: gate.refusal };
}

export async function retry(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: RetryInput,
): Promise<Outcome<RetryResult>> {
  const plan = await retryPlan(db, input.dispatch, input.host);
  if ("ok" in plan) return plan;
  const subject = await retrySubject(db, input.dispatch);
  if ("ok" in subject) return subject;
  const { original, task, seat, start } = subject;
  const method = await stepMethod(db, task.run_id, task.step_id);
  const { version } = await orca.version();
  const opKey =
    input.opKey ??
    retryOpKey(task, original.seat, await db.listDispatches(task.run_id));
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
    const ready = await retryGate(tx, {
      run,
      task: current,
      original,
      seat,
      start,
      host: input.host,
      capacity: input.capacity,
    });
    if (!ready.ok) return record(ready.refusal);
    const { launch } = ready;
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
      from: run.coordinator,
    };
  });

  const finish = (done: DispatchResult, taskView: string): RetryResult => ({
    ...done,
    retry_of: original.dispatch_id,
    task_view: taskView,
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
    return {
      ...again,
      result: finish(again.result, taskViewOf(manifest?.references, method)),
    };
  }

  const { launch } = gate;
  const taskView = taskViewOf(gate.references, method);
  log.at({ run_id: task.run_id, task_id: task.task_id, op_key: opKey });
  const receipt = await orca.workerStart({
    task: task.task_id,
    run: task.run_id,
    ...launch,
    from: gate.from,
  });
  const recorded = await recordReceipt(db, {
    opKey,
    request,
    launch,
    task,
    manifestId: gate.manifestId,
    generation: input.generation,
    promptBytes: Buffer.byteLength(taskView, "utf8"),
    verb: "retry",
    at: input.now(),
    receipt,
  });
  if (recorded.kind === "started")
    return {
      ok: true,
      result: finish(recorded.done, taskView),
      opKey,
      orca: version,
    };
  const sent =
    launch.retryOf === undefined
      ? `worker-start for Task ${task.task_id} (retry of ${original.dispatch_id})`
      : `worker-start --retry-of ${original.dispatch_id}`;
  if (recorded.kind === "failed")
    return refuse("failed", `${sent} failed`, [
      ...(receipt.result?.lastError == null
        ? []
        : [receipt.result.lastError]),
      "pod check",
    ]);
  return refuse("launch_unknown", `${sent} has no known outcome`, [
    input.command(opKey),
    "pod check",
  ]);
}
