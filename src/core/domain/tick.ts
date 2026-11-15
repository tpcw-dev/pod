import { z } from "zod";
import { Json } from "./json.ts";

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
