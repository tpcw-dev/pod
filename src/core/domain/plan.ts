import { z } from "zod";

export const PlanKind = z.enum([
  "published",
  "hold",
  "release",
  "priority",
  "order",
  "stretch",
  "reset_available",
]);
export type PlanKind = z.infer<typeof PlanKind>;

const Name = z.string().min(1);
const Day = z.iso.date();
const Instant = z.iso.datetime();

export function distinct(list: readonly string[]): boolean {
  return new Set(list).size === list.length;
}

const Names = z.array(Name).min(1).refine(distinct, "names one twice");

const Common = {
  host: Name,
  day: Day,
  actor: Name,
};

const Expiring = {
  until: Day.nullable(),
  expires_at: Instant,
};

export const Place = z.enum(["current", "milestone", "unlisted"]);
export type Place = z.infer<typeof Place>;

export const Ranked = z.strictObject({
  key: Name,
  project: Name,
  title: z.string(),
  points: z.int().nullable(),
  place: Place,
  priority: z.int().nullable(),
  driver: Name.nullable(),
  seats: z.array(Name),
  reasons: z.array(z.string()),
});
export type Ranked = z.infer<typeof Ranked>;

export const Held = z.strictObject({
  key: Name,
  reason: z.string(),
  project: Name.optional(),
});
export type Held = z.infer<typeof Held>;

export const PlanInputs = z.strictObject({
  host_revision: Name,
  project_revisions: z.array(Name),
  tracker: z.strictObject({ hash: Name, observed_at: Instant }).nullable(),
  usage_observation_ids: z.array(z.number()),
  overrides: z.array(z.number()),
});
export type PlanInputs = z.infer<typeof PlanInputs>;

export const PublishedPayload = z.strictObject({
  kind: z.literal("published"),
  ...Common,
  ranked: z.array(Ranked),
  held: z.array(Held),
  inputs: PlanInputs,
});

export const HoldPayload = z.strictObject({
  kind: z.literal("hold"),
  ...Common,
  ...Expiring,
  key: Name,
  reason: Name,
  project: Name.optional(),
});

export const ReleasePayload = z.strictObject({
  kind: z.literal("release"),
  ...Common,
  key: Name,
});

export const PriorityPayload = z.strictObject({
  kind: z.literal("priority"),
  ...Common,
  ...Expiring,
  projects: Names,
});

export const OrderPayload = z.strictObject({
  kind: z.literal("order"),
  ...Common,
  ...Expiring,
  keys: Names,
});

export const PlanPayload = z.discriminatedUnion("kind", [
  PublishedPayload,
  HoldPayload,
  ReleasePayload,
  PriorityPayload,
  OrderPayload,
]);
export type PlanPayload = z.infer<typeof PlanPayload>;
export type PublishedPayload = z.infer<typeof PublishedPayload>;
export type HoldPayload = z.infer<typeof HoldPayload>;
export type PriorityPayload = z.infer<typeof PriorityPayload>;
export type OrderPayload = z.infer<typeof OrderPayload>;

export type OverrideRequest =
  | {
      kind: "hold";
      key: string;
      reason: string;
      until: string | null;
      project?: string;
    }
  | { kind: "release"; key: string }
  | { kind: "priority"; projects: string[]; until: string | null }
  | { kind: "order"; keys: string[]; until: string | null };
