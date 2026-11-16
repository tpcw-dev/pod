import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import type { Db } from "../core/ports/db.ts";
import type { Refusal } from "../core/domain/outcome.ts";
import {
  Held,
  PlanInputs,
  Ranked,
  type OverrideRequest,
} from "../core/domain/plan.ts";
import { serviceKinds } from "../core/config/service-kinds.ts";
import { receiptLog } from "../core/ledger/receipts.ts";
import { publishPlan, readPlan, type PlanSources } from "../core/plan/plan.ts";
import { writeOverride } from "../core/plan/write.ts";
import { docsFor } from "./docs.ts";
import { PodError, exitFor, throwRecordRefusal } from "./errors.ts";
import {
  databaseUrl,
  readHostProfile,
  type HostSettings,
} from "./host-profile.ts";
import { actorOf, needsPerson, writerOf, type PersonNeed } from "./identity.ts";
import { trackerFor } from "./tracker.ts";

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
  project: z.string().optional(),
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
const StretchInForce = z.object({
  ...Stamp,
  slots: z.number(),
  reason: z.string(),
  expires_at: z.string(),
});
export const ResetInForce = z.object({
  ...Stamp,
  harness: z.string(),
  until: z.string(),
  expires_at: z.string(),
});
export const UsageGateJson = z.object({
  provider: z.string(),
  state: z.enum(["available", "held", "unknown", "reset"]),
  value: z.string().nullable(),
  pace: z.enum(["spend", "ok", "avoid"]).nullable(),
  window: z.string().nullable(),
  observation_id: z.number().nullable(),
});
export const OverridesJson = z.object({
  holds: z.array(HoldInForce),
  priority: PriorityInForce.nullable(),
  order: OrderInForce.nullable(),
});
export const CapacityJson = z.object({
  slots_default: z.number(),
  slots_max: z.number(),
  slots: z.number(),
  stretch: StretchInForce.nullable(),
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
  capacity: CapacityJson.extend({
    reserved: z.record(z.string(), z.number()),
  }),
  overrides: OverridesJson,
  resets: z.array(ResetInForce),
  usage: z.array(UsageGateJson),
  partial: z.array(z.object({ project: z.string(), error: z.string() })),
  ranked: z.array(Ranked),
  held: z.array(Held),
  reserved: z.array(
    z.object({
      project: z.string(),
      slots: z.number(),
      covers: z.array(z.string()),
    }),
  ),
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
  kind: z.enum([
    "hold",
    "release",
    "priority",
    "order",
    "stretch",
    "reset_available",
  ]),
  actor: z.string(),
  event_id: z.number(),
  op_key: z.string(),
  replayed: z.boolean(),
  key: z.string().optional(),
  reason: z.string().optional(),
  project: z.string().optional(),
  projects: z.array(z.string()).optional(),
  keys: z.array(z.string()).optional(),
  until: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  slots: z.number().optional(),
  harness: z.string().optional(),
  available: z.boolean().optional(),
});
type PlanOverrideOutput = z.infer<typeof PlanOverrideOutput>;

export function planOpKeyMeta(output: PlanOverrideOutput) {
  return { opKey: output.op_key };
}

async function withSources<R>(
  db: Db,
  profile: HostSettings,
  work: (sources: PlanSources) => Promise<R>,
): Promise<R> {
  const log = receiptLog(db, profile.hostId);
  const kinds = await serviceKinds(db);
  const tracker = await trackerFor(
    log.trackerSink,
    profile,
    kinds.estimateScale,
  );
  const docs = await docsFor(log.docsSink, profile, kinds.docsKind);
  const result = await work({
    tracker: tracker?.port ?? null,
    docs: docs?.port ?? null,
  });
  throwRecordRefusal([
    ...(tracker?.recordRefusals() ?? []),
    ...(docs?.recordRefusals() ?? []),
  ]);
  return result;
}

export async function plan(input: PlanInput): Promise<PlanOutput> {
  const profile = readHostProfile();
  const host = input.host ?? profile.hostId;
  const connection = connect(databaseUrl(profile));
  try {
    const db = connection.db;
    const now = new Date();
    const outcome = await withSources(db, profile, async (sources) =>
      input.publish === true
        ? publishPlan(db, {
            host,
            writer: profile.hostId,
            actor: actorOf(await writerOf(db, profile, process.env, null)),
            now,
            sources,
          })
        : readPlan(db, { host, now, sources }),
    );
    if (!outcome.ok) failWith(outcome.refusal);
    return outcome;
  } finally {
    await connection.close();
  }
}

async function override(
  hostFlag: string | undefined,
  request: OverrideRequest,
  need: PersonNeed | null = null,
): Promise<PlanOverrideOutput> {
  const profile = readHostProfile();
  const connection = connect(databaseUrl(profile));
  try {
    const identity = await writerOf(connection.db, profile, process.env, need);
    if (need !== null) needsPerson(identity, need);
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
  project: z.string().min(1).optional(),
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
    ...(input.project === undefined ? {} : { project: input.project }),
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

const stretchNeed: PersonNeed = {
  what: "a slots stretch",
  nextSteps: ["a person runs pod plan stretch from the operator's shell"],
};

export const PlanStretchInput = z.strictObject({
  args: z.tuple([z.string().regex(/^\d+$/u)]),
  reason: z.string().min(1),
  host: HostFlag,
});

export function planStretch(
  input: z.infer<typeof PlanStretchInput>,
): Promise<PlanOverrideOutput> {
  return override(
    input.host,
    { kind: "stretch", slots: Number(input.args[0]), reason: input.reason },
    stretchNeed,
  );
}

export const PlanResetAvailableInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  until: z.string().min(1),
  host: HostFlag,
});

export function planResetAvailable(
  input: z.infer<typeof PlanResetAvailableInput>,
): Promise<PlanOverrideOutput> {
  return override(input.host, {
    kind: "reset_available",
    harness: input.args[0],
    until: input.until,
  });
}

export const PlanResetUsedInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  host: HostFlag,
});

export function planResetUsed(
  input: z.infer<typeof PlanResetUsedInput>,
): Promise<PlanOverrideOutput> {
  return override(input.host, {
    kind: "reset_used",
    harness: input.args[0],
  });
}
