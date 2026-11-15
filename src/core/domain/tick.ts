import { z } from "zod";
import { Json } from "./json.ts";
import type { NewEvent } from "./ledger.ts";

const Name = z.string().min(1);

export const TriggerSource = z.enum([
  "orchestration",
  "tracker",
  "timer",
  "operator",
]);
export type TriggerSource = z.infer<typeof TriggerSource>;

export const TriggerPayload = z.strictObject({
  host: Name,
  source: TriggerSource,
  trigger_id: Name,
});
export type TriggerPayload = z.infer<typeof TriggerPayload>;

/** The trigger that makes the next `pod tick` of a Run's host due at once. */
export function orchestrationTrigger(input: {
  run: { run_id: string; host: string };
  trigger_id: string;
  writer: string;
  at: Date;
  verb: string;
}): NewEvent {
  return {
    type: "trigger",
    ts: input.at,
    host: input.writer,
    run_id: input.run.run_id,
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: Json.parse({
      host: input.run.host,
      source: "orchestration",
      trigger_id: input.trigger_id,
    }),
    source: Json.parse({ kind: "command", verb: input.verb }),
  };
}

export const stepNames = [
  "read_plan",
  "observe",
  "close",
  "launch",
  "attention",
  "write_tick",
] as const;
export const StepName = z.enum(stepNames);
export type StepName = z.infer<typeof StepName>;

export const StepOutcome = z.enum([
  "ok",
  "failed",
  "skipped",
  "not_built",
  "planned",
]);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const StepRecord = z.strictObject({
  step: StepName,
  op_key: Name,
  result: StepOutcome,
  detail: Json.nullable(),
});
export type StepRecord = z.infer<typeof StepRecord>;

export const NeedsHumanKind = z.enum([
  "dispatch_silent",
  "task_unlaunched",
  "run_hold",
  "decision_over_budget",
  "worker_ended",
  "escalation",
  "decision_needs_human",
]);
export type NeedsHumanKind = z.infer<typeof NeedsHumanKind>;

export const NeedsHumanLine = z.strictObject({
  kind: NeedsHumanKind,
  run_id: Name,
  story: z.string(),
  task_id: z.string().nullable(),
  dispatch_id: z.string().nullable(),
  decision_id: z.string().nullable(),
  event_id: z.number().nullable(),
  since: z.string(),
  text: z.string(),
});
export type NeedsHumanLine = z.infer<typeof NeedsHumanLine>;

export const TickLines = z.object({
  host: Name,
  tick_id: Name,
  event_id: z.number(),
  at: z.string(),
  needs_human: z.array(NeedsHumanLine),
});
export type TickLines = z.infer<typeof TickLines>;

export const TickPayload = z.strictObject({
  host: Name,
  tick_id: Name,
  actor: Name,
  schedule_revision: Name,
  plan_event: z.number().nullable(),
  overrides: z.array(z.number()),
  triggers: z.array(z.number()),
  steps: z.array(StepRecord),
  launch: z.array(Json),
  refuse: z.array(Json),
  needs_human: z.array(NeedsHumanLine).default([]),
});
export type TickPayload = z.infer<typeof TickPayload>;

export const metaStepNames = ["retro", "digest"] as const;
export const MetaStepName = z.enum(metaStepNames);
export type MetaStepName = z.infer<typeof MetaStepName>;

export const MetaStepOutcome = z.enum([
  "ok",
  "failed",
  "timed_out",
  "not_built",
  "planned",
]);
export type MetaStepOutcome = z.infer<typeof MetaStepOutcome>;

export const MetaStepRecord = z.strictObject({
  step: MetaStepName,
  op_key: Name,
  result: MetaStepOutcome,
  detail: Json.nullable(),
});
export type MetaStepRecord = z.infer<typeof MetaStepRecord>;

export const MetaTickPayload = z.strictObject({
  agenda: z.literal("meta"),
  host: Name,
  tick_id: Name,
  actor: Name,
  schedule_revision: Name,
  slot: Name,
  steps: z.array(MetaStepRecord),
});
export type MetaTickPayload = z.infer<typeof MetaTickPayload>;

export const Watermark = z.strictObject({
  event_id: z.int().positive(),
  ts: z.iso.datetime(),
});
export type Watermark = z.infer<typeof Watermark>;

export const MetaOutputRef = z.strictObject({
  step: MetaStepName,
  scope: Name,
  input: Watermark,
  verified: z.literal(true),
});
export type MetaOutputRef = z.infer<typeof MetaOutputRef>;
