import { z } from "zod";
import { snapshotHash } from "../config/canonical-json.ts";
import { noSingleActive, singleActive } from "../config/active.ts";
import { activeProfile } from "../config/policy.ts";
import { activeRate } from "../config/rate.ts";
import type { Revision } from "../domain/config.ts";
import type {
  Operation,
  Run,
  RunState,
  Size,
  Story,
} from "../domain/ledger.ts";
import { refuse, type Outcome, type Refused } from "../domain/outcome.ts";
import { failure, launchOutcome, stopOnOpen } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { recordRunManifest } from "../manifest/run-manifest.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { projectSteps } from "../process/project.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import { Selector } from "../process/schema.ts";
import {
  fits,
  selectProcess,
  type ActiveProcess,
  type ProcessRef,
  type SelectorErrorCode,
} from "../process/select.ts";
import {
  openCoordinator,
  openResidentAuditor,
  pairInput,
  seatRefusal,
  type Seats,
  type SeatRefusal,
} from "./coordinator.ts";
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
  project?: string | null;
  seats?: Seats;
  now: () => Date;
}

export interface RunCreateResult {
  run_id: string;
  story: string;
  process: string;
  snapshot_hash: string;
  owner_generation: number;
  state: RunState;
  coordinator_dispatch_id: string | null;
  auditor_dispatch_id: string | null;
  seat_refusal?: SeatRefusal;
  tasks: { task_id: string; step_id: string; role: string; state: string }[];
}

interface Context {
  db: Db;
  orca: OrcaPort;
  log: ReceiptLog;
  input: RunCreateInput;
  process: Revision;
  steps: Step[];
  size: Size;
}

const RunRef = z.looseObject({ run_id: z.string() });
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

interface Tracked {
  size: Size | null;
  stage: string | null;
  kickoffLine: ProcessRef | null;
  fields: Pick<Story, "status" | "title" | "kickoff_line">;
}

const untracked: Tracked = {
  size: null,
  stage: null,
  kickoffLine: null,
  fields: { status: null, title: null, kickoff_line: null },
};

async function readTracked(
  tracker: TrackerPort | null,
  log: ReceiptLog,
  input: RunCreateInput,
): Promise<Tracked | Refused> {
  if (tracker === null) return untracked;
  log.at({ run_id: null, task_id: null, op_key: null });
  const read = await tracker.readStory({
    provider: input.provider,
    external_id: input.story,
  });
  if (!read.ok)
    return refuse(
      "failed",
      `tracker read of story:${input.story} failed: ${read.error ?? "no reply"}`,
      [input.command],
    );
  if (read.result === null)
    return refuse("story_not_found", `no Story ${input.story} in the tracker`, [
      "check the Story id",
    ]);
  const story = read.result;
  return {
    size: story.size,
    stage: story.stageLabel,
    kickoffLine: story.kickoffLine,
    fields: {
      status: story.status,
      title: story.title,
      kickoff_line: story.kickoffText,
    },
  };
}

export async function runCreate(
  db: Db,
  orca: OrcaPort,
  tracker: TrackerPort | null,
  log: ReceiptLog,
  input: RunCreateInput,
): Promise<Outcome<RunCreateResult>> {
  const story = `story:${input.story}`;
  const tracked = await readTracked(tracker, log, input);
  if ("ok" in tracked) return tracked;
  const size = input.size ?? tracked.size;
  const stage = input.stage ?? tracked.stage;
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
    kickoffLine: tracked.kickoffLine,
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
  const projectRef = input.project ?? null;
  const scope = projectRef === null ? "global" : "project";
  const scopeRef = projectRef ?? "";
  const crew = await singleActive(db, "crew", scope, scopeRef);
  if (crew === null) return noSingleActive("crew", scope, scopeRef);
  const policy = await singleActive(db, "policy", scope, scopeRef);
  if (policy === null) return noSingleActive("policy", scope, scopeRef);
  const { version } = await orca.version();
  const ctx: Context = { db, orca, log, input, process, steps, size };
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
        ...tracked.fields,
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
    const rate = await tx.getActivation(activeRate);
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
      coordinator_dispatch_id: null,
    });
    await tx.insertSnapshot({
      run_id: runId,
      crew_revision_id: crew.id,
      process_revision_id: process.id,
      policy_revision_id: policy.id,
      rate_revision_id: rate?.revision_id ?? null,
      effective_gate_map: {},
      hash,
      pinned_at: at,
      project: projectRef,
      profile: activeProfile(policy.value),
    });
    await tx.upsertStory({
      provider: input.provider,
      external_id: input.story,
      size,
      stage,
      run_id: runId,
      dependencies: [],
      synced_at: at,
      ...tracked.fields,
    });
    await tx.moveOperation(
      opKey,
      "done",
      { run_id: runId, created_by: input.coordinator },
      at,
    );
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
  const refused = await projectSteps(
    {
      db,
      orca,
      log,
      process: ctx.process,
      steps: ctx.steps,
      host: input.host,
      command: input.command,
      source: { kind: "command", verb: "run create" },
      now: input.now,
    },
    runId,
  );
  if (refused !== null) return refused;
  const pair = await openPair(ctx, runId);
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
      state: run.state,
      coordinator_dispatch_id: run.coordinator_dispatch_id,
      auditor_dispatch_id: pair.auditor,
      ...(pair.refusal === null ? {} : { seat_refusal: pair.refusal }),
      tasks: tasks.map((task) => ({
        task_id: task.task_id,
        step_id: task.step_id,
        role: task.role,
        state: task.state,
      })),
    },
  };
}

interface Pair {
  auditor: string | null;
  refusal: SeatRefusal | null;
}

async function holdPair(
  ctx: Context,
  run: Run,
  refusal: SeatRefusal,
): Promise<Pair> {
  await ctx.db.transaction(async (tx) => {
    const current = await tx.lockRun(run.run_id);
    if (current === null) throw new Error(`Run ${run.run_id} vanished`);
    await tx.setRunCoordinator(run.run_id, {
      generation: current.owner_generation,
      dispatch_id: null,
      coordinator: current.coordinator,
    });
    if (current.state === "hold") return;
    await tx.setRunState(run.run_id, "hold");
    await tx.appendEvent({
      type: "hold",
      ts: ctx.input.now(),
      host: ctx.input.host,
      run_id: run.run_id,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: {
        reason: "seat_open",
        role: refusal.role,
        code: refusal.code,
        from: current.state,
      },
      source: { kind: "command", verb: "run create" },
    });
  });
  return { auditor: null, refusal };
}

async function openPair(ctx: Context, runId: string): Promise<Pair> {
  if (ctx.size !== "xl") return { auditor: null, refusal: null };
  const { db, orca, log, input } = ctx;
  const run = await db.getRun(runId);
  if (run === null) throw new Error(`Run ${runId} vanished`);
  const seats = pairInput(input.seats, input.host, input.now);
  const manifestId = (
    await db.transaction((tx) => recordRunManifest(tx, run, input.now()))
  ).id;
  const decider = await openCoordinator(db, orca, log, {
    ...seats,
    run,
    generation: run.owner_generation,
    viewPath: "",
    manifestId,
    relaunch: 0,
  });
  if (!decider.ok)
    return holdPair(ctx, run, seatRefusal("decider", decider.refusal));
  const seated = await db.getRun(runId);
  if (seated === null) throw new Error(`Run ${runId} vanished`);
  const auditor = await openResidentAuditor(db, orca, log, {
    ...seats,
    run: seated,
    manifestId,
    decider: decider.dispatch.dispatch_id,
  });
  if (!auditor.ok)
    return holdPair(ctx, run, seatRefusal("auditor", auditor.refusal));
  return { auditor: auditor.dispatch.dispatch_id, refusal: null };
}
