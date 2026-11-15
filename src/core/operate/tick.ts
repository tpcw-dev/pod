import { activeSchedule, scheduleMissing } from "../config/schedule.ts";
import { Json } from "../domain/json.ts";
import type { Refused } from "../domain/outcome.ts";
import type { StepName, StepOutcome, StepRecord } from "../domain/tick.ts";
import type { TickPayload } from "../domain/tick.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import { planHost } from "../plan/host.ts";
import { inForce, newestPublished, overrideIds } from "../plan/overrides.ts";
import type { Db, Repo } from "../ports/db.ts";
import {
  newestTick,
  pendingTriggers,
  recordTriggers,
  tickEvents,
  type RecordedTrigger,
  type TickEvent,
  type TriggerInput,
} from "./triggers.ts";

export interface PlanRead {
  event_id: number | null;
  day: string;
  overrides: number[];
}

export interface StepContext {
  db: Db;
  host: string;
  now: Date;
  writer: string;
  actor: string;
  opKey: string;
  plan: PlanRead | null;
  results: readonly StepRecord[];
}

export interface StepResult {
  result: "ok" | "failed";
  detail: Json | null;
  plan?: PlanRead;
}

export interface TickStep {
  name: StepName;
  built: boolean;
  run(ctx: StepContext): Promise<StepResult>;
}

export interface TickInput {
  host: string;
  writer: string;
  actor: string;
  now: Date;
  triggers: readonly TriggerInput[];
}

export interface TickOutcome {
  ok: true;
  host: string;
  outcome: "ran" | "coalesced" | "not due" | "dry run";
  due: boolean | null;
  tick_id: string | null;
  event_id: number | null;
  replayed: boolean;
  schedule_revision: string | null;
  recorded: RecordedTrigger[];
  consumed: number[];
  pending: number[];
  steps: StepRecord[];
  launch: Json[];
  refuse: Json[];
}

export async function readPlanStep(
  repo: Repo,
  host: string,
  now: Date,
): Promise<StepResult> {
  const context = await planHost(repo, host, now);
  if (!context.ok)
    return {
      result: "failed",
      detail: {
        code: context.refusal.code,
        message: context.refusal.message,
      },
    };
  const plan: PlanRead = {
    event_id: newestPublished(context.events, context.day)?.event_id ?? null,
    day: context.day,
    overrides: overrideIds(inForce(context.events, now)),
  };
  return { result: "ok", detail: Json.parse(plan), plan };
}

function slot(name: StepName): TickStep {
  return {
    name,
    built: false,
    run: () => Promise.reject(new Error(`${name} is not built`)),
  };
}

export const tickSteps: readonly TickStep[] = [
  {
    name: "read_plan",
    built: true,
    run: (ctx) => readPlanStep(ctx.db, ctx.host, ctx.now),
  },
  slot("observe"),
  slot("close"),
  slot("launch"),
  slot("attention"),
  {
    name: "write_tick",
    built: true,
    run: () => Promise.resolve({ result: "ok", detail: null }),
  },
];

const reads: readonly StepName[] = ["read_plan", "observe"];

export function stepOpKey(
  host: string,
  step: StepName,
  plan: PlanRead | null,
): string {
  return derivedOpKey("tick", {
    host,
    step,
    subject: String(plan?.event_id ?? "none"),
    story: "",
  });
}

function tickIdAfter(host: string, newest: TickEvent | null): string {
  return derivedOpKey("tick", { host, after: String(newest?.id ?? "none") });
}

function readIncomplete(results: readonly StepRecord[]): boolean {
  return results.some(
    (each) => reads.includes(each.step) && each.result === "failed",
  );
}

function record(
  ctx: Omit<StepContext, "opKey">,
  step: StepName,
  result: StepOutcome,
  detail: Json | null,
): StepRecord {
  return {
    step: step,
    op_key: stepOpKey(ctx.host, step, ctx.plan),
    result,
    detail,
  };
}

export interface StepsRun {
  plan: PlanRead | null;
  steps: StepRecord[];
}

export async function runSteps(
  db: Db,
  input: Omit<TickInput, "triggers">,
  steps: readonly TickStep[] = tickSteps,
): Promise<StepsRun> {
  let plan: PlanRead | null = null;
  const results: StepRecord[] = [];
  for (const step of steps) {
    const base = { db, ...input, plan, results };
    if (!step.built) {
      results.push(record(base, step.name, "not_built", null));
      continue;
    }
    if (step.name === "launch" && readIncomplete(results)) {
      results.push(record(base, step.name, "skipped", null));
      continue;
    }
    let outcome: StepResult;
    try {
      outcome = await step.run({
        ...base,
        opKey: stepOpKey(input.host, step.name, plan),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { result: "failed", detail: { message } };
    }
    if (outcome.plan !== undefined) plan = outcome.plan;
    // read_plan's key names the plan it read, so it is derived after the read.
    results.push(
      record({ ...base, plan }, step.name, outcome.result, outcome.detail),
    );
  }
  return { plan, steps: results };
}

function empty(
  host: string,
  outcome: TickOutcome["outcome"],
  recorded: RecordedTrigger[],
): TickOutcome {
  return {
    ok: true,
    host,
    outcome,
    due: null,
    tick_id: null,
    event_id: null,
    replayed: false,
    schedule_revision: null,
    recorded,
    consumed: [],
    pending: [],
    steps: [],
    launch: [],
    refuse: [],
  };
}

function isDue(
  pending: readonly number[],
  newest: TickEvent | null,
  tickMinutes: number,
  now: Date,
): boolean {
  if (pending.length > 0 || newest === null) return true;
  return now.getTime() - newest.ts.getTime() >= tickMinutes * 60_000;
}

async function writeTick(
  tx: Repo,
  input: TickInput,
  tickId: string,
  payload: TickPayload,
): Promise<{ event_id: number; replayed: boolean; payload: TickPayload }> {
  const { created } = await tx.insertOperation({
    op_key: tickId,
    intent: "tick",
    owner_generation: 0,
    at: input.now,
    result_ref: null,
  });
  if (!created) {
    const stored = (await tickEvents(tx, input.host)).find(
      (each) => each.op_key === tickId,
    );
    if (stored === undefined)
      throw new Error(`tick ${tickId} has an operation and no tick event`);
    return { event_id: stored.id, replayed: true, payload: stored.payload };
  }
  const appended = await tx.appendEvent({
    type: "tick",
    ts: input.now,
    host: input.writer,
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: tickId,
    payload: Json.parse(payload),
    source: Json.parse({ kind: "command", verb: "tick", actor: input.actor }),
  });
  await tx.moveOperation(tickId, "done", { event_id: appended.id }, input.now);
  return { event_id: appended.id, replayed: false, payload };
}

/**
 * Runs one host's operate agenda once. The lock transaction holds one pool
 * connection while the steps commit on others, so the pool needs at least two.
 */
export async function runTick(
  db: Db,
  input: TickInput,
  steps: readonly TickStep[] = tickSteps,
): Promise<TickOutcome | Refused> {
  const recorded = await recordTriggers(db, input);
  return db.transaction(async (lockTx): Promise<TickOutcome | Refused> => {
    if (!(await lockTx.tryLockTick(input.host)))
      return empty(input.host, "coalesced", recorded);
    const schedule = await activeSchedule(lockTx, input.host);
    if (schedule === null)
      return { ok: false, refusal: scheduleMissing(input.host) };
    const ticks = await tickEvents(lockTx, input.host);
    const newest = newestTick(ticks);
    const pending = await pendingTriggers(lockTx, input.host, ticks);
    if (!isDue(pending, newest, schedule.value.tick_minutes, input.now))
      return {
        ...empty(input.host, "not due", recorded),
        due: false,
        schedule_revision: schedule.revision_id,
      };
    const run = await runSteps(db, input, steps);
    const consumed = await pendingTriggers(lockTx, input.host, ticks);
    const tickId = tickIdAfter(input.host, newest);
    const written = await writeTick(lockTx, input, tickId, {
      host: input.host,
      tick_id: tickId,
      actor: input.actor,
      schedule_revision: schedule.revision_id,
      plan_event: run.plan?.event_id ?? null,
      overrides: run.plan?.overrides ?? [],
      triggers: consumed,
      steps: run.steps,
      launch: [],
      refuse: [],
    });
    const listed = new Set(written.payload.triggers);
    return {
      ok: true,
      host: input.host,
      outcome: "ran",
      due: true,
      tick_id: tickId,
      event_id: written.event_id,
      replayed: written.replayed,
      schedule_revision: written.payload.schedule_revision,
      recorded,
      consumed: written.payload.triggers,
      pending: (await pendingTriggers(lockTx, input.host, ticks)).filter(
        (id) => !listed.has(id),
      ),
      steps: written.payload.steps,
      launch: written.payload.launch,
      refuse: written.payload.refuse,
    };
  });
}

export async function dryRunTick(
  repo: Repo,
  input: Pick<TickInput, "host" | "now" | "triggers">,
  steps: readonly TickStep[] = tickSteps,
): Promise<TickOutcome | Refused> {
  const schedule = await activeSchedule(repo, input.host);
  if (schedule === null)
    return { ok: false, refusal: scheduleMissing(input.host) };
  const ticks = await tickEvents(repo, input.host);
  const newest = newestTick(ticks);
  const pending = await pendingTriggers(repo, input.host, ticks);
  const due =
    input.triggers.length > 0 ||
    isDue(pending, newest, schedule.value.tick_minutes, input.now);
  const read = await readPlanStep(repo, input.host, input.now);
  const plan = read.plan ?? null;
  return {
    ...empty(input.host, "dry run", []),
    due,
    tick_id: tickIdAfter(input.host, newest),
    schedule_revision: schedule.revision_id,
    pending,
    steps: steps.map((step) => ({
      step: step.name,
      op_key: stepOpKey(input.host, step.name, plan),
      result: step.built ? "planned" : "not_built",
      detail: step.name === "read_plan" ? read.detail : null,
    })),
  };
}
