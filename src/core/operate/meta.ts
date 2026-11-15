import { packetLimits, type PacketLimits } from "../config/packet-limits.ts";
import {
  activeSchedule,
  scheduleMissing,
  type MetaSlot,
} from "../config/schedule.ts";
import { Json } from "../domain/json.ts";
import type { EventType } from "../domain/ledger.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import {
  MetaTickPayload,
  type MetaStepName,
  type MetaStepRecord,
  type Watermark,
} from "../domain/tick.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import { hostDay, hostTime } from "../plan/clock.ts";
import { planHost } from "../plan/host.ts";
import type { Db, Repo } from "../ports/db.ts";
import { buildPacket, type Packet, type PacketInput } from "./packet.ts";
import { metaStepOpKey, readWatermark } from "./watermark.ts";

export interface MetaStepContext {
  db: Db;
  host: string;
  now: Date;
  writer: string;
  actor: string;
  step: MetaStepName;
  scope: string;
  opKey: string;
  watermark: Watermark | null;
  packet: Packet;
  limits: PacketLimits;
  signal: AbortSignal;
}

export interface MetaStepResult {
  result: "ok" | "failed";
  detail: Json | null;
}

export interface MetaStep {
  name: MetaStepName;
  built: boolean;
  output: EventType;
  scope(host: string): string;
  input: PacketInput;
  run(ctx: MetaStepContext): Promise<MetaStepResult>;
}

export interface MetaClock {
  deadline(minutes: number, signal: AbortSignal): Promise<void>;
}

export const realClock: MetaClock = {
  deadline: (minutes, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, minutes * 60_000);
      signal.addEventListener("abort", () => clearTimeout(timer));
    }),
};

function slot(name: MetaStepName): MetaStep {
  return {
    name,
    built: false,
    output: name,
    scope: (host) => `host:${host}`,
    input: () => Promise.resolve([]),
    run: () => Promise.reject(new Error(`${name} is not built`)),
  };
}

export const metaSteps: readonly MetaStep[] = [slot("retro"), slot("digest")];

export interface MetaInput {
  host: string;
  writer: string;
  actor: string;
  now: Date;
  slot?: string;
}

export interface MetaSlotOutcome {
  slot: string;
  due: boolean;
  tick_id: string | null;
  event_id: number | null;
  replayed: boolean;
  steps: MetaStepRecord[];
}

export interface MetaOutcome {
  ok: true;
  host: string;
  agenda: "meta";
  outcome: "ran" | "coalesced" | "not due" | "dry run";
  schedule_revision: string | null;
  slots: MetaSlotOutcome[];
}

export interface MetaTickEvent {
  id: number;
  ts: Date;
  op_key: string | null;
  payload: MetaTickPayload;
}

export async function metaTickEvents(
  repo: Repo,
  host: string,
): Promise<MetaTickEvent[]> {
  return (await repo.eventsWith("tick", { host, agenda: "meta" })).flatMap(
    (each) => {
      const parsed = MetaTickPayload.safeParse(each.payload);
      return parsed.success
        ? [
            {
              id: each.id,
              ts: each.ts,
              op_key: each.op_key,
              payload: parsed.data,
            },
          ]
        : [];
    },
  );
}

function metaTickId(
  host: string,
  slot: string,
  ticks: readonly MetaTickEvent[],
): string {
  const newest = ticks
    .filter((each) => each.payload.slot === slot)
    .reduce<number | null>((max, each) => Math.max(max ?? 0, each.id), null);
  return derivedOpKey("tick", {
    host,
    agenda: "meta",
    slot,
    after: String(newest ?? "none"),
  });
}

function stepsOf(
  names: readonly MetaStepName[],
  steps: readonly MetaStep[],
): MetaStep[] {
  return names.flatMap((name) => steps.filter((step) => step.name === name));
}

interface Planned {
  schedule_revision: string;
  timezone: string;
  slots: { slot: MetaSlot; due: boolean }[];
}

async function plan(
  repo: Repo,
  input: Pick<MetaInput, "host" | "now" | "slot">,
): Promise<Planned | Refused> {
  const schedule = await activeSchedule(repo, input.host);
  if (schedule === null)
    return { ok: false, refusal: scheduleMissing(input.host) };
  const context = await planHost(repo, input.host, input.now);
  if (!context.ok) return context;
  const slots = schedule.value.meta_slots ?? [];
  const ticks = await metaTickEvents(repo, input.host);
  const today = hostDay(input.now, context.timezone);
  const time = hostTime(input.now, context.timezone);
  const due = (each: MetaSlot) =>
    time >= each.at &&
    !ticks.some(
      (tick) =>
        tick.payload.slot === each.name &&
        hostDay(tick.ts, context.timezone) === today,
    );
  if (input.slot !== undefined) {
    const named = slots.find((each) => each.name === input.slot);
    if (named === undefined)
      return refuse(
        "usage",
        `host ${input.host}'s schedule has no meta slot ${input.slot}`,
        slots.length === 0
          ? ["add meta_slots to the host's schedule Revision"]
          : slots.map((each) => `pod tick --agenda meta --slot ${each.name}`),
      );
    return {
      schedule_revision: schedule.revision_id,
      timezone: context.timezone,
      slots: [{ slot: named, due: due(named) }],
    };
  }
  return {
    schedule_revision: schedule.revision_id,
    timezone: context.timezone,
    slots: slots.filter(due).map((each) => ({ slot: each, due: true })),
  };
}

async function runCapped(
  step: MetaStep,
  ctx: Omit<MetaStepContext, "signal">,
  clock: MetaClock,
): Promise<{ result: MetaStepRecord["result"]; detail: Json | null }> {
  const controller = new AbortController();
  const running = step
    .run({ ...ctx, signal: controller.signal })
    .then((outcome) => ({ outcome }));
  running.catch(() => undefined);
  const timer = clock
    .deadline(ctx.limits.minutes, controller.signal)
    .then(() => "timed_out" as const);
  try {
    const first = await Promise.race([running, timer]);
    if (first === "timed_out")
      return {
        result: "timed_out",
        detail: { packet_minutes: ctx.limits.minutes },
      };
    return first.outcome;
  } finally {
    controller.abort();
  }
}

async function runStep(
  db: Db,
  input: Omit<MetaInput, "slot">,
  step: MetaStep,
  clock: MetaClock,
): Promise<MetaStepRecord> {
  const scope = step.scope(input.host);
  const watermark = await readWatermark(db, step.output, step.name, scope);
  const opKey = metaStepOpKey(step.name, scope, watermark);
  const record = (
    result: MetaStepRecord["result"],
    detail: Json | null,
  ): MetaStepRecord => ({ step: step.name, op_key: opKey, result, detail });
  if (!step.built) return record("not_built", null);
  try {
    const limits = await packetLimits(db);
    if (limits === null)
      return record("failed", {
        code: "config_missing",
        message:
          "the active global policy has no valid limits.packet_items, packet_words, and packet_minutes",
      });
    const packet = await buildPacket(
      db,
      step.input,
      { host: input.host, now: input.now, scope, watermark },
      limits,
    );
    const outcome = await runCapped(
      step,
      {
        db,
        ...input,
        step: step.name,
        scope,
        opKey,
        watermark,
        packet,
        limits,
      },
      clock,
    );
    return record(outcome.result, outcome.detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return record("failed", { message });
  }
}

/** Runs one slot's steps in order; a failing step does not stop later ones. */
export async function runMetaSteps(
  db: Db,
  input: Omit<MetaInput, "slot">,
  names: readonly MetaStepName[],
  steps: readonly MetaStep[] = metaSteps,
  clock: MetaClock = realClock,
): Promise<MetaStepRecord[]> {
  const records: MetaStepRecord[] = [];
  for (const step of stepsOf(names, steps))
    records.push(await runStep(db, input, step, clock));
  return records;
}

export async function writeMetaTick(
  tx: Repo,
  input: Omit<MetaInput, "slot">,
  tickId: string,
  payload: MetaTickPayload,
): Promise<{ event_id: number; replayed: boolean; payload: MetaTickPayload }> {
  const { created } = await tx.insertOperation({
    op_key: tickId,
    intent: "tick",
    owner_generation: 0,
    at: input.now,
    result_ref: null,
  });
  if (!created) {
    const stored = (await metaTickEvents(tx, input.host)).find(
      (each) => each.op_key === tickId,
    );
    if (stored === undefined)
      throw new Error(`meta tick ${tickId} has an operation and no tick event`);
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
    source: Json.parse({
      kind: "command",
      verb: "tick",
      agenda: "meta",
      actor: input.actor,
    }),
  });
  await tx.moveOperation(tickId, "done", { event_id: appended.id }, input.now);
  return { event_id: appended.id, replayed: false, payload };
}

function outcomeOf(
  host: string,
  outcome: MetaOutcome["outcome"],
  scheduleRevision: string | null,
  slots: MetaSlotOutcome[],
): MetaOutcome {
  return {
    ok: true,
    host,
    agenda: "meta",
    outcome,
    schedule_revision: scheduleRevision,
    slots,
  };
}

/**
 * Runs one host's due meta slots once each under `tick:<host>:meta`, apart
 * from the operate lock. As in `runTick`, the lock transaction holds only the
 * lock and the meta tick events while the steps commit on other connections.
 */
export async function runMeta(
  db: Db,
  input: MetaInput,
  steps: readonly MetaStep[] = metaSteps,
  clock: MetaClock = realClock,
): Promise<MetaOutcome | Refused> {
  return db.transaction(async (lockTx): Promise<MetaOutcome | Refused> => {
    if (!(await lockTx.tryLockTick(input.host, "meta")))
      return outcomeOf(input.host, "coalesced", null, []);
    const planned = await plan(lockTx, input);
    if ("ok" in planned) return planned;
    if (planned.slots.length === 0)
      return outcomeOf(input.host, "not due", planned.schedule_revision, []);
    const ran: MetaSlotOutcome[] = [];
    for (const { slot, due } of planned.slots) {
      const tickId = metaTickId(
        input.host,
        slot.name,
        await metaTickEvents(lockTx, input.host),
      );
      const records = await runMetaSteps(db, input, slot.steps, steps, clock);
      const written = await writeMetaTick(lockTx, input, tickId, {
        agenda: "meta",
        host: input.host,
        tick_id: tickId,
        actor: input.actor,
        schedule_revision: planned.schedule_revision,
        slot: slot.name,
        steps: records,
      });
      ran.push({
        slot: slot.name,
        due,
        tick_id: tickId,
        event_id: written.event_id,
        replayed: written.replayed,
        steps: written.payload.steps,
      });
    }
    return outcomeOf(input.host, "ran", planned.schedule_revision, ran);
  });
}

export async function dryRunMeta(
  repo: Repo,
  input: Pick<MetaInput, "host" | "now" | "slot">,
  steps: readonly MetaStep[] = metaSteps,
): Promise<MetaOutcome | Refused> {
  const planned = await plan(repo, input);
  if ("ok" in planned) return planned;
  const ticks = await metaTickEvents(repo, input.host);
  const slots: MetaSlotOutcome[] = [];
  for (const { slot, due } of planned.slots) {
    const records: MetaStepRecord[] = [];
    for (const step of stepsOf(slot.steps, steps)) {
      const scope = step.scope(input.host);
      const watermark = await readWatermark(
        repo,
        step.output,
        step.name,
        scope,
      );
      records.push({
        step: step.name,
        op_key: metaStepOpKey(step.name, scope, watermark),
        result: step.built ? "planned" : "not_built",
        detail: null,
      });
    }
    slots.push({
      slot: slot.name,
      due,
      tick_id: metaTickId(input.host, slot.name, ticks),
      event_id: null,
      replayed: false,
      steps: records,
    });
  }
  return outcomeOf(input.host, "dry run", planned.schedule_revision, slots);
}
