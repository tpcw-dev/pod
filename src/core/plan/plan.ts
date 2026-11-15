import { refuse, type Refused } from "../domain/outcome.ts";
import type { PlanInputs, PublishedPayload } from "../domain/plan.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { DocsPort } from "../ports/docs.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import {
  readCandidates,
  type Candidates,
  type PartialRead,
} from "./candidates.ts";
import { planHost, type PlanHost } from "./host.ts";
import {
  inForce,
  newestPublished,
  overrideIds,
  type InForce,
  type PublishedRead,
} from "./overrides.ts";
import { rankPlan, type Ranking } from "./rank.ts";
import { appendKeyed, opKeyBase, replayOf, type WriteInput } from "./write.ts";

export interface PlanSources {
  tracker: TrackerPort | null;
  docs: DocsPort | null;
}

export interface PlanView extends Ranking {
  ok: true;
  host: string;
  day: string;
  timezone: string;
  host_revision: string;
  capacity: {
    slots_default: number;
    slots_max: number;
    reserved: Record<string, number>;
  };
  overrides: InForce;
  partial: PartialRead[];
  published: (PublishedRead & { replayed?: boolean }) | null;
}

interface Read {
  context: PlanHost;
  candidates: Candidates;
}

function view(
  { context, candidates }: Read,
  now: Date,
): Omit<PlanView, "published"> {
  const overrides = inForce(context.events, now);
  return {
    ok: true,
    host: context.host,
    day: context.day,
    timezone: context.timezone,
    host_revision: context.revision_id,
    capacity: {
      slots_default: context.slots.default,
      slots_max: context.slots.max,
      reserved: context.reserved,
    },
    overrides,
    partial: candidates.partial,
    ...rankPlan({
      stories: candidates.stories,
      overrides,
      activations: candidates.activations,
      reserved: context.reserved,
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
  return { context, candidates };
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
    const current = view({ context, candidates }, input.now);
    const inputs: PlanInputs = {
      host_revision: context.revision_id,
      project_revisions: candidates.project_revisions,
      tracker: candidates.tracker,
      usage_observation_ids: [],
      overrides: overrideIds(current.overrides),
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
