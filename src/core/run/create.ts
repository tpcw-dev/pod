import { z } from "zod";
import { snapshotHash } from "../config/canonical-json.ts";
import { noSingleActive, singleActive } from "../config/active.ts";
import type { Revision } from "../domain/config.ts";
import { Json } from "../domain/json.ts";
import type { Operation, Size } from "../domain/ledger.ts";
import { refuse, type Outcome } from "../domain/outcome.ts";
import { launchOutcome, stopOnOpen } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { Selector } from "../process/schema.ts";
import {
  fits,
  selectProcess,
  type ActiveProcess,
  type ProcessRef,
  type SelectorErrorCode,
} from "../process/select.ts";
import { readSteps, StepsInvalid, topoOrder, type Step } from "./steps.ts";

export interface RunCreateInput {
  story: string;
  process: ProcessRef | null;
  size: Size | null;
  stage: string | null;
  coordinator: string;
  host: string;
  provider: string;
  command: string;
  now: () => Date;
}

export interface RunCreateResult {
  run_id: string;
  story: string;
  process: string;
  snapshot_hash: string;
  owner_generation: number;
  tasks: { task_id: string; step_id: string; role: string; state: string }[];
}

interface Context {
  db: Db;
  orca: OrcaPort;
  log: ReceiptLog;
  input: RunCreateInput;
  process: Revision;
  steps: Step[];
}

const RunRef = z.looseObject({ run_id: z.string() });
const TaskRef = z.looseObject({ task_id: z.string() });
const FailedRef = z.looseObject({ outcome: z.literal("failed") });

function refOf(revision: Pick<Revision, "name" | "rev">): string {
  return `process.${revision.name}@${revision.rev}`;
}

function activeOf(revision: Revision): ActiveProcess | null {
  const value = revision.value;
  const selector = Selector.safeParse(
    value !== null && typeof value === "object" && "selector" in value
      ? value.selector
      : undefined,
  );
  return selector.success
    ? {
        revisionId: revision.id,
        name: revision.name,
        rev: revision.rev,
        selector: selector.data,
      }
    : null;
}

async function activeProcesses(db: Repo): Promise<ActiveProcess[]> {
  const rows = await db.listActivations("process", "global", "");
  const active: ActiveProcess[] = [];
  for (const row of rows) {
    const revision = await db.getRevision(row.revision_id);
    const process = revision === null ? null : activeOf(revision);
    if (process !== null) active.push(process);
  }
  return active;
}

function notSelected(
  code: SelectorErrorCode,
  story: string,
  stage: string,
  size: Size,
  input: RunCreateInput,
  activations: readonly ActiveProcess[],
) {
  const at = `stage ${stage}, size ${size}`;
  if (code === "selector_conflict")
    return refuse(
      code,
      `${input.process === null ? "the named process" : refOf(input.process)} does not fit ${at}`,
      ["--process name@rev names a process whose selector fits"],
    );
  if (code === "selector_none")
    return refuse(code, `no process Revision fits ${story} at ${at}`, [
      "--process name@rev",
    ]);
  const matching = activations
    .filter((active) => fits(active.selector, stage, size))
    .map(refOf);
  return refuse(
    code,
    `several process Revisions fit ${story} at ${at}: ${matching.join(", ")}`,
    [
      "--process name@rev",
      ...matching.map((ref) => `--process ${ref.slice("process.".length)}`),
    ],
  );
}

function stepsOf(process: Revision) {
  try {
    return { ok: true as const, steps: topoOrder(readSteps(process.value)) };
  } catch (error) {
    if (!(error instanceof StepsInvalid)) throw error;
    return refuse("schema_invalid", `${refOf(process)} ${error.message}`, [
      error.path,
    ]);
  }
}

function failure(verb: string, raw: unknown, exitCode: number): Json {
  return { outcome: "failed", verb, exitCode, raw: Json.parse(raw ?? null) };
}

export async function runCreate(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: RunCreateInput,
): Promise<Outcome<RunCreateResult>> {
  const story = `story:${input.story}`;
  const { size, stage } = input;
  if (size === null)
    return refuse("selector_none", `${story} has no size`, [
      "--size xs|s|m|l|xl",
    ]);
  if (stage === null)
    return refuse("selector_none", `${story} has no stage`, ["--stage T"]);
  let named: Revision | null = null;
  if (input.process !== null) {
    named = await db.getRevisionByRef(
      "process",
      input.process.name,
      input.process.rev,
    );
    if (named === null)
      return refuse(
        "revision_not_found",
        `no Revision ${refOf(input.process)}`,
        ["pod config apply FILE"],
      );
    const checked = stepsOf(named);
    if (!checked.ok) return checked;
  }
  const activations = await activeProcesses(db);
  const selected = selectProcess({
    stage,
    size,
    kickoffLine: null,
    cliProcess: input.process,
    activations,
    named: named === null ? null : activeOf(named),
  });
  if (!selected.ok)
    return notSelected(selected.code, story, stage, size, input, activations);
  const process =
    named?.id === selected.revisionId
      ? named
      : await db.getRevision(selected.revisionId);
  if (process === null)
    throw new Error(`Revision ${selected.revisionId} vanished`);
  const checked = stepsOf(process);
  if (!checked.ok) return checked;
  const { steps } = checked;
  const crew = await singleActive(db, "crew", "global", "");
  if (crew === null) return noSingleActive("crew", "global");
  const policy = await singleActive(db, "policy", "global", "");
  if (policy === null) return noSingleActive("policy", "global");
  const { version } = await orca.version();
  const ctx: Context = { db, orca, log, input, process, steps };
  const opKey = derivedOpKey("run_create", {
    provider: input.provider,
    external_id: input.story,
  });
  const now = input.now();
  const first = await db.transaction(async (tx) => {
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "run_create",
      owner_generation: 1,
      at: now,
    });
    if (inserted.created)
      await tx.upsertStory({
        provider: input.provider,
        external_id: input.story,
        size,
        stage,
        run_id: null,
        dependencies: [],
        synced_at: now,
      });
    return inserted;
  });
  if (!first.created) return recorded(ctx, first.operation, opKey, version);

  log.at({ run_id: null, task_id: null, op_key: opKey });
  const receipt = await orca.runCreate({ objective: `Pod Run for ${story}` });
  const outcome = launchOutcome(receipt);
  if (outcome.kind === "unknown") {
    await db.moveOperation(
      opKey,
      "unknown",
      { verb: "run-create", requestId: outcome.requestId },
      input.now(),
    );
    return refuse(
      "launch_unknown",
      `run-create for ${story} has no known outcome`,
      [input.command, "pod check"],
    );
  }
  if (outcome.kind === "failed" || receipt.result === null) {
    await db.moveOperation(
      opKey,
      "done",
      failure("run-create", receipt.raw, receipt.exitCode),
      input.now(),
    );
    return refuse("failed", `run-create for ${story} failed`, ["pod check"]);
  }
  const runId = receipt.result.run.id;
  const hash = snapshotHash(
    {
      crew: crew.id,
      process: process.id,
      policy: policy.id,
    },
    {},
  );
  const at = input.now();
  await db.transaction(async (tx) => {
    await tx.insertRun({
      run_id: runId,
      story_provider: input.provider,
      story_external_id: input.story,
      host: input.host,
      coordinator: input.coordinator,
      owner_generation: 1,
      snapshot_hash: hash,
      state: "active",
      created_at: at,
    });
    await tx.insertSnapshot({
      run_id: runId,
      crew_revision_id: crew.id,
      process_revision_id: process.id,
      policy_revision_id: policy.id,
      effective_gate_map: {},
      hash,
      pinned_at: at,
    });
    await tx.upsertStory({
      provider: input.provider,
      external_id: input.story,
      size,
      stage,
      run_id: runId,
      dependencies: [],
      synced_at: at,
    });
    await tx.moveOperation(opKey, "done", { run_id: runId }, at);
  });
  return project(ctx, runId, opKey, version);
}

async function recorded(
  ctx: Context,
  operation: Operation,
  opKey: string,
  version: string,
): Promise<Outcome<RunCreateResult>> {
  if (operation.intent !== "run_create")
    return refuse(
      "duplicate_op",
      `op key ${opKey} belongs to intent ${operation.intent}`,
      ["pass a new --op-key"],
    );
  if (operation.status === "unknown" || operation.status === "pending")
    return stopOnOpen(
      ctx.orca,
      ctx.log,
      { run_id: null, task_id: null, op_key: opKey },
      operation,
      ctx.input.command,
    );
  const run = RunRef.safeParse(operation.result_ref);
  if (!run.success || FailedRef.safeParse(operation.result_ref).success)
    return refuse(
      "failed",
      `run-create for story:${ctx.input.story} failed before`,
      ["pod check"],
    );
  const snapshot = await ctx.db.getSnapshot(run.data.run_id);
  if (snapshot !== null && snapshot.process_revision_id !== ctx.process.id) {
    const pinned = await ctx.db.getRevision(snapshot.process_revision_id);
    return refuse(
      "selector_conflict",
      `Run ${run.data.run_id} pins ${pinned === null ? snapshot.process_revision_id : `process.${pinned.name}@${pinned.rev}`}, not process.${ctx.process.name}@${ctx.process.rev}`,
      [
        "drop --process or name the pinned Revision",
        `pod brief story:${ctx.input.story}`,
      ],
    );
  }
  return project(ctx, run.data.run_id, opKey, version);
}

async function project(
  ctx: Context,
  runId: string,
  opKey: string,
  version: string,
): Promise<Outcome<RunCreateResult>> {
  const { db, orca, log, input } = ctx;
  const taskIds = new Map<string, string>();
  for (const step of ctx.steps) {
    const stepKey = derivedOpKey("project", {
      run_id: runId,
      step_id: step.id,
    });
    const { operation, created } = await db.insertOperation({
      op_key: stepKey,
      intent: "project",
      owner_generation: 1,
      at: input.now(),
    });
    if (!created) {
      if (operation.status === "unknown" || operation.status === "pending")
        return stopOnOpen(
          orca,
          log,
          { run_id: runId, task_id: null, op_key: stepKey },
          operation,
          input.command,
        );
      const task = TaskRef.safeParse(operation.result_ref);
      if (!task.success)
        return refuse(
          "failed",
          `task-create for step ${step.id} failed before`,
          ["pod check"],
        );
      taskIds.set(step.id, task.data.task_id);
      continue;
    }
    const deps = step.needs.map((need) => taskIds.get(need) ?? need);
    log.at({ run_id: runId, task_id: null, op_key: stepKey });
    const receipt = await orca.taskCreate({
      spec:
        step.spec ??
        `Process ${ctx.process.name}@${ctx.process.rev}, step ${step.id}, role ${step.role ?? step.type}.`,
      run: runId,
      ...(deps.length > 0 ? { deps } : {}),
      taskTitle: step.id,
    });
    const outcome = launchOutcome(receipt);
    if (outcome.kind !== "ok" || receipt.result === null) {
      const unknown = outcome.kind === "unknown";
      await db.transaction(async (tx) => {
        const at = input.now();
        await tx.moveOperation(
          stepKey,
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
          host: input.host,
          run_id: runId,
          task_id: null,
          dispatch_id: null,
          op_key: stepKey,
          payload: {
            reason: unknown ? "launch_unknown" : "failed",
            op_key: stepKey,
            ...(from === undefined ? {} : { from }),
          },
          source: { kind: "command", verb: "run create" },
        });
      });
      return unknown
        ? refuse(
            "launch_unknown",
            `task-create for step ${step.id} has no known outcome`,
            [input.command, "pod check"],
          )
        : refuse("failed", `task-create for step ${step.id} failed`, [
            "pod check",
          ]);
    }
    const taskId = receipt.result.task.id;
    taskIds.set(step.id, taskId);
    await db.transaction(async (tx) => {
      const at = input.now();
      await tx.insertTask({
        task_id: taskId,
        run_id: runId,
        step_id: step.id,
        lineage_id: `${runId}:${step.id}`,
        role: step.role ?? step.type,
        deps,
        spec_revision_id: ctx.process.id,
        state: deps.length === 0 ? "ready" : "pending",
        created_at: at,
      });
      await tx.moveOperation(stepKey, "done", { task_id: taskId }, at);
    });
  }
  const run = await db.getRun(runId);
  if (run === null) throw new Error(`Run ${runId} vanished`);
  const tasks = await db.listTasks(runId);
  return {
    ok: true,
    opKey,
    orca: version,
    result: {
      run_id: runId,
      story: `story:${input.story}`,
      process: `process.${ctx.process.name}@${ctx.process.rev}`,
      snapshot_hash: run.snapshot_hash,
      owner_generation: run.owner_generation,
      tasks: tasks.map((task) => ({
        task_id: task.task_id,
        step_id: task.step_id,
        role: task.role,
        state: task.state,
      })),
    },
  };
}
