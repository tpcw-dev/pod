import { z } from "zod";
import type { Revision } from "../domain/config.ts";
import { Json } from "../domain/json.ts";
import type { Task } from "../domain/ledger.ts";
import { refuse, type Checked, type Refused } from "../domain/outcome.ts";
import { TaskTransitionInvalid, type TaskState } from "../domain/task-state.ts";
import { failure, launchOutcome, stopOnOpen } from "../ledger/launch.ts";
import { moveTask } from "../ledger/move-task.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  edgeOutcomes,
  ProcessValue,
  type Outcome,
  type Step as ProcessStep,
} from "./schema.ts";

export interface ProjectStep {
  id: string;
  type: string;
  role: string | null;
  needs: readonly string[];
  spec: string | null;
}

export interface ProjectContext {
  db: Db;
  orca: OrcaPort;
  log: ReceiptLog;
  process: Pick<Revision, "id" | "name" | "rev">;
  host: string;
  command: string;
  source: Json;
  now: () => Date;
}

interface TaskPlan {
  runId: string;
  step: ProjectStep;
  opKey: string;
  deps: string[];
  reworkOf: string | null;
  state: TaskState;
  specRevisionId?: string;
}

const TaskRef = z.looseObject({ task_id: z.string() });
const Deps = z.array(z.string());
const satisfied: readonly TaskState[] = ["passed", "done"];
const terminal: readonly TaskState[] = ["done", "failed", "superseded"];

function allSatisfied(
  deps: readonly string[],
  states: ReadonlyMap<string, TaskState>,
): boolean {
  return deps.every((dep) => {
    const state = states.get(dep);
    return state !== undefined && satisfied.includes(state);
  });
}

function depsOf(task: Task): string[] {
  const parsed = Deps.safeParse(task.deps);
  return parsed.success ? parsed.data : [];
}

function lineageOf(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

async function callTaskCreate(
  ctx: Pick<ProjectContext, "orca" | "log" | "process">,
  plan: Pick<TaskPlan, "runId" | "step" | "opKey" | "deps">,
) {
  const { runId, step, opKey, deps } = plan;
  ctx.log.at({ run_id: runId, task_id: null, op_key: opKey });
  const receipt = await ctx.orca.taskCreate({
    spec:
      step.spec ??
      `Process ${ctx.process.name}@${ctx.process.rev}, step ${step.id}, role ${step.role ?? step.type}.`,
    run: runId,
    ...(deps.length > 0 ? { deps } : {}),
    taskTitle: step.id,
  });
  return { receipt, outcome: launchOutcome(receipt) };
}

export type Replacement =
  | { kind: "created"; taskId: string }
  | { kind: "retry"; message: string }
  | { kind: "wait"; message: string };

const OpenRequest = z.looseObject({ requestId: z.string().nullish() });

export function supersedeOpKey(decisionId: string): string {
  return derivedOpKey("decide", {
    decision_id: decisionId,
    effect: "change_spec",
  });
}

export function replacementOpKey(
  superseded: Pick<Task, "run_id" | "step_id" | "task_id">,
  attempt: number,
): string {
  return derivedOpKey("project", {
    run_id: superseded.run_id,
    step_id: superseded.step_id,
    supersede: superseded.task_id,
    attempt: String(attempt),
  });
}

export async function createReplacement(
  ctx: Pick<ProjectContext, "db" | "orca" | "log" | "process" | "now">,
  plan: Pick<TaskPlan, "runId" | "step" | "opKey" | "deps">,
): Promise<Replacement> {
  const { db, orca, log } = ctx;
  const { opKey } = plan;
  const failed = `task-create for the replacement under ${opKey} failed; run pod check again`;
  const { operation: existing, created } = await db.insertOperation({
    op_key: opKey,
    intent: "project",
    owner_generation: 1,
    at: ctx.now(),
  });
  if (!created) {
    if (existing.status === "done" || existing.status === "refused") {
      const task = TaskRef.safeParse(existing.result_ref);
      return task.success
        ? { kind: "created", taskId: task.data.task_id }
        : { kind: "retry", message: failed };
    }
    const requestId =
      OpenRequest.safeParse(existing.result_ref).data?.requestId ?? null;
    const waiting = `task-create for the replacement under ${opKey} has no known task id (request ${requestId ?? "none"}); the change_spec effect waits for the operator`;
    if (requestId === null) return { kind: "wait", message: waiting };
    log.at({ run_id: plan.runId, task_id: null, op_key: opKey });
    const shown = await orca.requestShow({ request: requestId });
    const state = shown.result?.state;
    if (state === "absent") {
      await db.moveOperation(
        opKey,
        "done",
        { outcome: "absent", request_id: requestId },
        ctx.now(),
      );
      return { kind: "retry", message: failed };
    }
    if (state === "pending")
      return {
        kind: "wait",
        message: `task-create for the replacement under ${opKey} is pending (request ${requestId}); run pod check again`,
      };
    return { kind: "wait", message: waiting };
  }
  const { receipt, outcome } = await callTaskCreate(ctx, plan);
  const at = ctx.now();
  if (outcome.kind === "ok" && receipt.result !== null) {
    const taskId = receipt.result.task.id;
    await db.moveOperation(opKey, "done", { task_id: taskId }, at);
    return { kind: "created", taskId };
  }
  if (outcome.kind === "unknown") {
    await db.moveOperation(
      opKey,
      "unknown",
      { verb: "task-create", requestId: outcome.requestId },
      at,
    );
    return {
      kind: "wait",
      message: `task-create for the replacement under ${opKey} has no known outcome; run pod check again`,
    };
  }
  await db.moveOperation(
    opKey,
    "done",
    failure("task-create", receipt.raw, receipt.exitCode),
    at,
  );
  return { kind: "retry", message: failed };
}

function newestOf(tasks: readonly Task[], taskId: string): string {
  const task = tasks.find((row) => row.task_id === taskId);
  if (task === undefined) return taskId;
  const lineage = tasks.filter((row) => row.lineage_id === task.lineage_id);
  return (
    lineage.find((row) =>
      lineage.every((other) => other.rework_of !== row.task_id),
    )?.task_id ?? taskId
  );
}

export async function rerouteDeps(
  tx: Repo,
  runId: string,
  map: ReadonlyMap<string, string>,
  skip: readonly string[],
): Promise<void> {
  for (const row of await tx.listTasks(runId)) {
    if (terminal.includes(row.state) || skip.includes(row.task_id)) continue;
    const deps = depsOf(row);
    const next = deps.map((dep) => map.get(dep) ?? dep);
    if (next.some((dep, i) => dep !== deps[i]))
      await tx.setTaskDeps(row.task_id, next);
  }
}

export function replacementDeps(
  tasks: readonly Task[],
  superseded: Task,
): string[] {
  return depsOf(superseded).map((dep) => newestOf(tasks, dep));
}

export async function applySupersede(
  tx: Repo,
  input: {
    superseded: Task;
    replacementId: string;
    revisionId: string;
    at: Date;
  },
): Promise<{ state: TaskState }> {
  const { superseded } = input;
  const tasks = await tx.listTasks(superseded.run_id);
  const deps = replacementDeps(tasks, superseded);
  const states = new Map(tasks.map((row) => [row.task_id, row.state]));
  const state: TaskState = allSatisfied(deps, states) ? "ready" : "pending";
  await moveTask(tx, superseded.task_id, "superseded");
  await tx.insertTask({
    task_id: input.replacementId,
    run_id: superseded.run_id,
    step_id: superseded.step_id,
    lineage_id: superseded.lineage_id,
    role: superseded.role,
    deps,
    spec_revision_id: input.revisionId,
    state,
    rework_of: superseded.task_id,
    created_at: input.at,
  });
  await rerouteDeps(
    tx,
    superseded.run_id,
    new Map([[superseded.task_id, input.replacementId]]),
    [input.replacementId],
  );
  return { state };
}

async function createTask(
  ctx: ProjectContext,
  plan: TaskPlan,
): Promise<{ ok: true; taskId: string } | Refused> {
  const { db, orca, log } = ctx;
  const { runId, step, opKey, deps } = plan;
  const { operation, created } = await db.insertOperation({
    op_key: opKey,
    intent: "project",
    owner_generation: 1,
    at: ctx.now(),
  });
  if (!created) {
    if (operation.status === "unknown" || operation.status === "pending")
      return stopOnOpen(
        orca,
        log,
        { run_id: runId, task_id: null, op_key: opKey },
        operation,
        ctx.command,
      );
    const task = TaskRef.safeParse(operation.result_ref);
    if (!task.success)
      return refuse("failed", `task-create for step ${step.id} failed before`, [
        "pod check",
      ]);
    return { ok: true, taskId: task.data.task_id };
  }
  const { receipt, outcome } = await callTaskCreate(ctx, plan);
  if (outcome.kind !== "ok" || receipt.result === null) {
    const unknown = outcome.kind === "unknown";
    await db.transaction(async (tx) => {
      const at = ctx.now();
      await tx.moveOperation(
        opKey,
        unknown ? "unknown" : "done",
        unknown
          ? { verb: "task-create", requestId: outcome.requestId }
          : failure("task-create", receipt.raw, receipt.exitCode),
        at,
      );
      const from = (await tx.getRun(runId))?.state;
      await tx.setRunState(runId, "hold");
      await tx.appendEvent({
        type: "hold",
        ts: at,
        host: ctx.host,
        run_id: runId,
        task_id: null,
        dispatch_id: null,
        op_key: opKey,
        payload: {
          reason: unknown ? "launch_unknown" : "failed",
          op_key: opKey,
          ...(from === undefined ? {} : { from }),
        },
        source: ctx.source,
      });
    });
    return unknown
      ? refuse(
          "launch_unknown",
          `task-create for step ${step.id} has no known outcome`,
          [ctx.command, "pod check"],
        )
      : refuse("failed", `task-create for step ${step.id} failed`, [
          "pod check",
        ]);
  }
  const taskId = receipt.result.task.id;
  await db.transaction(async (tx) => {
    const at = ctx.now();
    await tx.insertTask({
      task_id: taskId,
      run_id: runId,
      step_id: step.id,
      lineage_id: lineageOf(runId, step.id),
      role: step.role ?? step.type,
      deps,
      spec_revision_id: plan.specRevisionId ?? ctx.process.id,
      state: plan.state,
      rework_of: plan.reworkOf,
      created_at: at,
    });
    await tx.moveOperation(opKey, "done", { task_id: taskId }, at);
  });
  return { ok: true, taskId };
}

export async function projectSteps(
  ctx: ProjectContext & { steps: readonly ProjectStep[] },
  runId: string,
): Promise<Refused | null> {
  const taskIds = new Map<string, string>();
  for (const step of ctx.steps) {
    const deps = step.needs.map((need) => taskIds.get(need) ?? need);
    const created = await createTask(ctx, {
      runId,
      step,
      opKey: derivedOpKey("project", { run_id: runId, step_id: step.id }),
      deps,
      reworkOf: null,
      state: deps.length === 0 ? "ready" : "pending",
    });
    if (!created.ok) return created;
    taskIds.set(step.id, created.taskId);
  }
  return null;
}

export interface OutcomeInput {
  task: string;
  outcome: Outcome;
  at: Date;
  host: string;
  source: Json;
}

export interface OutcomeResult {
  task_id: string;
  outcome: Outcome;
  state: TaskState;
  promoted: string[];
  created: string[];
  replayed: boolean;
}

interface ReadProcess {
  revision: Revision;
  value: ProcessValue;
  step: ProcessStep;
}

interface ReworkPlan {
  failed: Task;
  target: ProcessStep;
  then: ProcessStep | null;
  read: ReadProcess;
}

export type Recorded =
  | { kind: "settled"; state: TaskState; promoted: string[]; replayed: boolean }
  | { kind: "rework"; plan: ReworkPlan; replayed: boolean };

function invalid(task: Task, outcome: string, detail: string) {
  return new TaskTransitionInvalid(
    task.task_id,
    task.state,
    `the ${outcome} edge`,
    detail,
  );
}

export async function readProcess(
  tx: Repo,
  task: Task,
  outcome: string,
): Promise<ReadProcess> {
  const snapshot = await tx.getSnapshot(task.run_id);
  if (snapshot === null)
    throw invalid(task, outcome, `Run ${task.run_id} has no snapshot`);
  const revision = await tx.getRevision(snapshot.process_revision_id);
  const parsed =
    revision === null ? null : ProcessValue.safeParse(revision.value);
  if (revision === null || parsed?.success !== true)
    throw invalid(
      task,
      outcome,
      `process Revision ${snapshot.process_revision_id} unreadable`,
    );
  const step = parsed.data.steps.find((row) => row.id === task.step_id);
  if (step === undefined)
    throw invalid(task, outcome, `step ${task.step_id} is not in the process`);
  return { revision, value: parsed.data, step };
}

function stepOf(read: ReadProcess, id: string, task: Task, outcome: string) {
  const step = read.value.steps.find((row) => row.id === id);
  if (step === undefined)
    throw invalid(task, outcome, `step ${id} is not in the process`);
  return step;
}

async function promote(tx: Repo, runId: string): Promise<string[]> {
  const tasks = await tx.listTasks(runId);
  const states = new Map(tasks.map((task) => [task.task_id, task.state]));
  const promoted: string[] = [];
  for (const task of tasks) {
    if (task.state !== "pending") continue;
    if (!allSatisfied(depsOf(task), states)) continue;
    await moveTask(tx, task.task_id, "ready");
    promoted.push(task.task_id);
  }
  return promoted;
}

const Latest = z.looseObject({
  outcome: z.string().optional(),
  reason: z.string().optional(),
});

async function latest(
  tx: Repo,
  task: Task,
  type: "outcome" | "hold",
  field: "outcome" | "reason",
): Promise<string | null> {
  const event = await tx.latestEvent(task.run_id, type, {
    taskId: task.task_id,
  });
  const parsed = Latest.safeParse(event?.payload);
  return parsed.success ? (parsed.data[field] ?? null) : null;
}

export async function recordOutcome(
  tx: Repo,
  input: OutcomeInput,
): Promise<Recorded> {
  const task = await tx.getTask(input.task);
  if (task === null)
    throw new TaskTransitionInvalid(
      input.task,
      "missing",
      `the ${input.outcome} edge`,
      `no Task ${input.task}`,
    );
  const { outcome } = input;
  const read = await readProcess(tx, task, outcome);
  const edge = read.value.edges.find(
    (row) => row.from === read.step.id && edgeOutcomes(row).includes(outcome),
  );
  if (edge === undefined)
    throw invalid(
      task,
      outcome,
      `step ${read.step.id} has no edge for ${outcome}`,
    );
  const event = (type: "outcome" | "hold", payload: Json) =>
    tx.appendEvent({
      type,
      ts: input.at,
      host: input.host,
      run_id: task.run_id,
      task_id: task.task_id,
      dispatch_id: null,
      op_key: null,
      payload,
      source: input.source,
    });
  const recordEdge = () =>
    event("outcome", {
      task_id: task.task_id,
      step_id: task.step_id,
      lineage_id: task.lineage_id,
      outcome,
      edge: {
        to: edge.to,
        new_task: edge.new_task ?? false,
        then: edge.then ?? null,
      },
    });
  const settled = (state: TaskState, promoted: string[], replayed: boolean) =>
    ({ kind: "settled", state, promoted, replayed }) as const;

  if (edge.to === "hold") {
    if (
      task.state === "hold" &&
      (await latest(tx, task, "outcome", "outcome")) === outcome
    )
      return settled("hold", [], true);
    await moveTask(tx, task.task_id, "hold");
    await event("hold", { reason: "edge", outcome, from: task.state });
    await recordEdge();
    return settled("hold", [], false);
  }

  if (outcome === "FAIL") {
    const target = stepOf(read, edge.to, task, outcome);
    const then =
      edge.then === undefined ? null : stepOf(read, edge.then, task, outcome);
    const plan = { failed: task, target, then, read };
    if (
      task.state === "failed" &&
      (await latest(tx, task, "outcome", "outcome")) === outcome
    )
      return { kind: "rework", plan, replayed: true };
    if (
      task.state === "hold" &&
      (await latest(tx, task, "hold", "reason")) === "rework_limit"
    )
      return settled("hold", [], true);
    const lineage = lineageOf(task.run_id, target.id);
    const tasks = await tx.listTasks(task.run_id);
    const superseded = new Set(
      tasks
        .filter((row) => row.state === "superseded")
        .map((row) => row.task_id),
    );
    const reworks = tasks.filter(
      (row) =>
        row.lineage_id === lineage &&
        row.rework_of !== null &&
        !superseded.has(row.rework_of),
    ).length;
    if (
      task.state === "delivered" &&
      reworks >= read.value.limits.rework_per_lineage
    ) {
      await moveTask(tx, task.task_id, "hold");
      await event("hold", {
        reason: "rework_limit",
        lineage_id: lineage,
        from: task.state,
      });
      await recordEdge();
      return settled("hold", [], false);
    }
    await moveTask(tx, task.task_id, "failed");
    await recordEdge();
    return { kind: "rework", plan, replayed: false };
  }

  if (task.state === "done") return settled("done", [], true);
  await moveTask(tx, task.task_id, "passed");
  await moveTask(tx, task.task_id, "done");
  await recordEdge();
  return settled("done", await promote(tx, task.run_id), false);
}

export async function recordDelivery(
  tx: Repo,
  input: Omit<OutcomeInput, "outcome"> & { settlement: "done" | "failed" },
): Promise<void> {
  const task = await tx.getTask(input.task);
  if (task?.state !== "delivered") return;
  const outcome = input.settlement === "done" ? "done" : "unknown";
  const { step } = await readProcess(tx, task, outcome);
  if (step.gate !== undefined || step.decision !== undefined) return;
  await recordOutcome(tx, { ...input, outcome });
}

function toProjectStep(step: ProcessStep): ProjectStep {
  return {
    id: step.id,
    type: step.type,
    role: step.role ?? null,
    needs: step.needs,
    spec: step.spec ?? null,
  };
}

const TaskSpecValue = z.looseObject({ spec: z.string() });

async function agreedSpec(
  db: Repo,
  step: ProjectStep,
  newestId: string | null,
): Promise<{ step: ProjectStep; specRevisionId?: string }> {
  const newest = newestId === null ? null : await db.getTask(newestId);
  const revision =
    newest === null ? null : await db.getRevision(newest.spec_revision_id);
  const value = TaskSpecValue.safeParse(revision?.value);
  if (revision?.kind !== "task" || !value.success) return { step };
  return {
    step: { ...step, spec: value.data.spec },
    specRevisionId: revision.id,
  };
}

async function rework(
  ctx: ProjectContext,
  plan: ReworkPlan,
): Promise<{ ok: true; created: string[] } | Refused> {
  const { db } = ctx;
  const { failed, target, then } = plan;
  const runId = failed.run_id;
  const tasks = await db.listTasks(runId);
  const newest = (stepId: string) => {
    const lineage = tasks.filter(
      (row) => row.lineage_id === lineageOf(runId, stepId),
    );
    return (
      lineage.find((row) =>
        lineage.every((other) => other.rework_of !== row.task_id),
      )?.task_id ?? null
    );
  };
  const states = new Map(tasks.map((row) => [row.task_id, row.state]));
  const targetDeps = target.needs.flatMap((need) => newest(need) ?? []);
  const key = (stepId: string) =>
    derivedOpKey("project", {
      run_id: runId,
      step_id: stepId,
      rework: failed.task_id,
    });
  const made = await createTask(ctx, {
    runId,
    ...(await agreedSpec(db, toProjectStep(target), newest(target.id))),
    opKey: key(target.id),
    deps: targetDeps,
    reworkOf: newest(target.id),
    state: allSatisfied(targetDeps, states) ? "ready" : "pending",
  });
  if (!made.ok) return made;
  const created = [made.taskId];
  let replacement = made.taskId;
  if (then !== null) {
    const next = await createTask(ctx, {
      runId,
      ...(await agreedSpec(db, toProjectStep(then), newest(then.id))),
      opKey: key(then.id),
      deps: [made.taskId],
      reworkOf: newest(then.id),
      state: "pending",
    });
    if (!next.ok) return next;
    created.push(next.taskId);
    replacement = next.taskId;
  }
  await db.transaction(async (tx) => {
    await tx.lockRun(runId);
    const replaced = (await tx.getTask(made.taskId))?.rework_of ?? null;
    const map = new Map<string, string>([[failed.task_id, replacement]]);
    if (replaced !== null && replaced !== failed.task_id)
      map.set(replaced, made.taskId);
    await rerouteDeps(tx, runId, map, created);
  });
  return { ok: true, created };
}

export async function applyOutcome(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: OutcomeInput & { command: string; now: () => Date },
): Promise<Checked<OutcomeResult>> {
  const { version } = await orca.version();
  const recorded = await db.transaction(async (tx) => {
    const task = await tx.getTask(input.task);
    if (task !== null) await tx.lockRun(task.run_id);
    return recordOutcome(tx, input);
  });
  return followOutcome(db, orca, log, recorded, { ...input, version });
}

export async function followOutcome(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  recorded: Recorded,
  input: OutcomeInput & { command: string; now: () => Date; version: string },
): Promise<Checked<OutcomeResult>> {
  const { version } = input;
  const result = (state: TaskState, promoted: string[], created: string[]) => ({
    ok: true as const,
    orca: version,
    result: {
      task_id: input.task,
      outcome: input.outcome,
      state,
      promoted,
      created,
      replayed: recorded.replayed,
    },
  });
  if (recorded.kind === "settled")
    return result(recorded.state, recorded.promoted, []);
  const { revision } = recorded.plan.read;
  const made = await rework(
    {
      db,
      orca,
      log,
      process: revision,
      host: input.host,
      command: input.command,
      source: input.source,
      now: input.now,
    },
    recorded.plan,
  );
  if (!made.ok) return made;
  return result("failed", [], made.created);
}
