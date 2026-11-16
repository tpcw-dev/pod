import { refuse, type Refused } from "../domain/outcome.ts";
import type { PlanInputs, PublishedPayload } from "../domain/plan.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { DocsPort } from "../ports/docs.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import { capacityOf } from "./capacity.ts";
import {
  crewProviders,
  readCandidates,
  type Candidates,
  type PartialRead,
} from "./candidates.ts";
import { planHost, seatedProjects, type PlanHost } from "./host.ts";
import {
  inForce,
  newestPublished,
  overrideIds,
  resetsInForce,
  stretchInForce,
  type InForce,
  type PublishedRead,
  type ResetInForce,
  type StretchInForce,
} from "./overrides.ts";
import { rankPlan, type Ranking } from "./rank.ts";
import { observationIds, usageGates, type UsageGate } from "./usage.ts";
import { appendKeyed, opKeyBase, replayOf, type WriteInput } from "./write.ts";

export interface PlanSources {
  tracker: TrackerPort | null;
  docs: DocsPort | null;
}

export interface Capacity {
  slots_default: number;
  slots_max: number;
  slots: number;
  stretch: StretchInForce | null;
}

export interface PlanView extends Ranking {
  ok: true;
  host: string;
  day: string;
  timezone: string;
  host_revision: string;
  capacity: Capacity & { reserved: Record<string, number> };
  overrides: InForce;
  resets: ResetInForce[];
  usage: UsageGate[];
  partial: PartialRead[];
  published: (PublishedRead & { replayed?: boolean }) | null;
}

interface Read {
  context: PlanHost;
  candidates: Candidates;
  usage: UsageGate[];
}

function capacity(context: PlanHost, now: Date): Capacity {
  const stretch = stretchInForce(context.events, now);
  return {
    slots_default: context.slots.default,
    slots_max: context.slots.max,
    slots: capacityOf(context.slots, stretch),
    stretch,
  };
}

function allProviders(providers: Record<string, string[]>): string[] {
  return [...new Set(Object.values(providers).flat())].sort();
}

function gatesOf(
  repo: Repo,
  context: PlanHost,
  providers: Record<string, string[]>,
  now: Date,
): Promise<UsageGate[]> {
  return usageGates(
    repo,
    allProviders(providers),
    resetsInForce(context.events, now),
    now,
  );
}

function view(
  { context, candidates, usage }: Read,
  now: Date,
): Omit<PlanView, "published"> {
  const overrides = inForce(context.events, now);
  return {
    ok: true,
    host: context.host,
    day: context.day,
    timezone: context.timezone,
    host_revision: context.revision_id,
    capacity: { ...capacity(context, now), reserved: context.reserved },
    overrides,
    resets: resetsInForce(context.events, now),
    usage,
    partial: candidates.partial,
    ...rankPlan({
      stories: candidates.stories,
      overrides,
      activations: candidates.activations,
      reserved: context.reserved,
      providers: candidates.providers,
      usage,
    }),
  };
}

async function readSources(
  repo: Repo,
  input: { host: string; now: Date; sources: PlanSources },
): Promise<Read | Refused> {
  const context = await planHost(repo, input.host, input.now);
  if (!context.ok) return context;
  const candidates = await readCandidates({
    repo,
    ...input.sources,
    context,
    now: input.now,
  });
  const usage = await gatesOf(repo, context, candidates.providers, input.now);
  return { context, candidates, usage };
}

export async function readPlan(
  repo: Repo,
  input: { host: string; now: Date; sources: PlanSources },
): Promise<PlanView | Refused> {
  const read = await readSources(repo, input);
  if ("ok" in read) return read;
  return {
    ...view(read, input.now),
    published: newestPublished(read.context.events, read.context.day),
  };
}

function trackerPartial(
  host: string,
  partial: readonly PartialRead[],
): Refused {
  return refuse(
    "tracker_partial",
    partial
      .map((each) => `Project ${each.project} read failed: ${each.error}.`)
      .join(" "),
    [`Run pod plan --host ${host} to see each partial read.`],
  );
}

function hostChanged(host: string, read: string, now: string): Refused {
  return refuse(
    "revision_conflict",
    `host ${host}'s active host Revision moved from ${read} to ${now} during the plan read`,
    [`pod plan --host ${host} --publish`],
  );
}

export interface PublishInput extends WriteInput {
  sources: PlanSources;
}

export async function publishPlan(
  db: Db,
  input: PublishInput,
): Promise<PlanView | Refused> {
  const read = await readSources(db, input);
  if ("ok" in read) return read;
  const { candidates } = read;
  if (candidates.partial.length > 0)
    return trackerPartial(input.host, candidates.partial);
  return db.transaction(async (tx) => {
    const context = await planHost(tx, input.host, input.now);
    if (!context.ok) return context;
    if (context.revision_id !== candidates.host_revision)
      return hostChanged(
        input.host,
        candidates.host_revision,
        context.revision_id,
      );
    const usage = await gatesOf(tx, context, candidates.providers, input.now);
    const current = view({ context, candidates, usage }, input.now);
    const inputs: PlanInputs = {
      host_revision: context.revision_id,
      project_revisions: candidates.project_revisions,
      tracker: candidates.tracker,
      usage_observation_ids: observationIds(usage),
      overrides: overrideIds(
        current.overrides,
        current.capacity.stretch,
        current.resets,
      ),
    };
    const payload: PublishedPayload = {
      kind: "published",
      host: context.host,
      day: context.day,
      actor: input.actor,
      ranked: current.ranked,
      held: current.held,
      inputs,
    };
    const base = opKeyBase(context, "published", {
      ranked: payload.ranked,
      held: payload.held,
      inputs,
    });
    const keyed =
      replayOf(context, base, payload) ??
      (await appendKeyed(tx, {
        context,
        base,
        payload,
        verb: "plan",
        writer: input.writer,
        now: input.now,
      }));
    const stored = keyed.payload.kind === "published" ? keyed.payload : payload;
    return {
      ...current,
      ranked: stored.ranked,
      held: stored.held,
      published: {
        event_id: keyed.event_id,
        ts: keyed.ts.toISOString(),
        op_key: keyed.op_key,
        actor: stored.actor,
        ranked: stored.ranked,
        held: stored.held,
        inputs: stored.inputs,
        replayed: keyed.replayed,
      },
    };
  });
}

export interface PlanDigest {
  ok: true;
  host: string;
  day: string;
  capacity: Capacity;
  overrides: InForce;
  resets: ResetInForce[];
  usage: UsageGate[];
  published: PublishedRead | null;
}

export async function planDigest(
  repo: Repo,
  host: string,
  now: Date,
): Promise<PlanDigest | Refused> {
  const context = await planHost(repo, host, now);
  if (!context.ok) return context;
  const seated = await seatedProjects(repo, context);
  const providers = await crewProviders(
    repo,
    seated.map((each) => each.name),
  );
  return {
    ok: true,
    host: context.host,
    day: context.day,
    capacity: capacity(context, now),
    overrides: inForce(context.events, now),
    resets: resetsInForce(context.events, now),
    usage: await gatesOf(repo, context, providers, now),
    published: newestPublished(context.events, context.day),
  };
}
