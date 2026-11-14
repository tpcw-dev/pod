import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import type { Refusal } from "../core/domain/outcome.ts";
import {
  Held,
  PlanInputs,
  Ranked,
  type OverrideRequest,
} from "../core/domain/plan.ts";
import { publishPlan, readPlan } from "../core/plan/plan.ts";
import { writeOverride } from "../core/plan/write.ts";
import { PodError, exitFor } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { actorOf, writerOf } from "./identity.ts";

function failWith(refusal: Refusal): never {
  throw new PodError(
    refusal.code,
    exitFor(refusal.code),
    refusal.message,
    refusal.nextSteps,
  );
}

const HostFlag = z.string().min(1).optional();
const Until = z.string().min(1).optional();

const Stamp = {
  event_id: z.number(),
  ts: z.string(),
  actor: z.string(),
};

const Expiry = {
  until: z.string().nullable(),
  expires_at: z.string(),
};

const HoldInForce = z.object({
  ...Stamp,
  ...Expiry,
  key: z.string(),
  reason: z.string(),
});
const PriorityInForce = z.object({
  ...Stamp,
  ...Expiry,
  projects: z.array(z.string()),
});
const OrderInForce = z.object({
  ...Stamp,
  ...Expiry,
  keys: z.array(z.string()),
});

export const PlanInput = z.strictObject({
  args: z.tuple([]),
  host: HostFlag,
  publish: z.boolean().optional(),
});
type PlanInput = z.infer<typeof PlanInput>;

export const PlanOutput = z.object({
  host: z.string(),
  day: z.string(),
  timezone: z.string(),
  host_revision: z.string(),
  capacity: z.object({
    slots_default: z.number(),
    slots_max: z.number(),
    reserved: z.record(z.string(), z.number()),
  }),
  overrides: z.object({
    holds: z.array(HoldInForce),
    priority: PriorityInForce.nullable(),
    order: OrderInForce.nullable(),
  }),
  ranked: z.array(Ranked),
  held: z.array(Held),
  published: z
    .object({
      ...Stamp,
      op_key: z.string(),
      ranked: z.array(Ranked),
      held: z.array(Held),
      inputs: PlanInputs,
      replayed: z.boolean().optional(),
    })
    .nullable(),
});
type PlanOutput = z.infer<typeof PlanOutput>;

export const PlanOverrideOutput = z.object({
  host: z.string(),
  day: z.string(),
  kind: z.enum(["hold", "release", "priority", "order"]),
  actor: z.string(),
  event_id: z.number(),
  op_key: z.string(),
  replayed: z.boolean(),
  key: z.string().optional(),
  reason: z.string().optional(),
  projects: z.array(z.string()).optional(),
  keys: z.array(z.string()).optional(),
  until: z.string().nullable().optional(),
  expires_at: z.string().optional(),
});
type PlanOverrideOutput = z.infer<typeof PlanOverrideOutput>;

export function planOpKeyMeta(output: PlanOverrideOutput) {
  return { opKey: output.op_key };
}

export async function plan(input: PlanInput): Promise<PlanOutput> {
  const profile = readHostProfile();
  const host = input.host ?? profile.hostId;
  const connection = connect(databaseUrl(profile));
  try {
    const db = connection.db;
    const now = new Date();
    const outcome =
      input.publish === true
        ? await publishPlan(db, {
            host,
            writer: profile.hostId,
            actor: actorOf(await writerOf(db, profile, process.env, false)),
            now,
          })
        : await readPlan(db, { host, now });
    if (!outcome.ok) failWith(outcome.refusal);
    return outcome;
  } finally {
    await connection.close();
  }
}

async function override(
  hostFlag: string | undefined,
  request: OverrideRequest,
): Promise<PlanOverrideOutput> {
  const profile = readHostProfile();
  const connection = connect(databaseUrl(profile));
  try {
    const identity = await writerOf(connection.db, profile, process.env, false);
    const outcome = await writeOverride(connection.db, {
      host: hostFlag ?? profile.hostId,
      writer: profile.hostId,
      actor: actorOf(identity),
      now: new Date(),
      request,
    });
    if (!outcome.ok) failWith(outcome.refusal);
    if (outcome.kind === "published")
      throw new Error("an override wrote a published plan");
    return outcome;
  } finally {
    await connection.close();
  }
}

export const PlanHoldInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  reason: z.string().min(1),
  until: Until,
  host: HostFlag,
});

export function planHold(
  input: z.infer<typeof PlanHoldInput>,
): Promise<PlanOverrideOutput> {
  return override(input.host, {
    kind: "hold",
    key: input.args[0],
    reason: input.reason,
    until: input.until ?? null,
  });
}

export const PlanReleaseInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  host: HostFlag,
});

export function planRelease(
  input: z.infer<typeof PlanReleaseInput>,
): Promise<PlanOverrideOutput> {
  return override(input.host, { kind: "release", key: input.args[0] });
}

export const PlanListInput = z.strictObject({
  args: z.tuple([z.string().min(1)], z.string().min(1)),
  until: Until,
  host: HostFlag,
});
type PlanListInput = z.infer<typeof PlanListInput>;

export function planPriority(
  input: PlanListInput,
): Promise<PlanOverrideOutput> {
  return override(input.host, {
    kind: "priority",
    projects: [...input.args],
    until: input.until ?? null,
  });
}

export function planOrder(input: PlanListInput): Promise<PlanOverrideOutput> {
  return override(input.host, {
    kind: "order",
    keys: [...input.args],
    until: input.until ?? null,
  });
}
