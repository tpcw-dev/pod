import type { Refused } from "../domain/outcome.ts";
import type { PlanInputs, PublishedPayload } from "../domain/plan.ts";
import type { Db, Repo } from "../ports/db.ts";
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
  published: (PublishedRead & { replayed?: boolean }) | null;
}

function view(context: PlanHost, now: Date): Omit<PlanView, "published"> {
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
    ...rankPlan({
      host: context.host,
      day: context.day,
      slots: context.slots.default,
      overrides,
    }),
  };
}

export async function readPlan(
  repo: Repo,
  input: { host: string; now: Date },
): Promise<PlanView | Refused> {
  const context = await planHost(repo, input.host, input.now);
  if (!context.ok) return context;
  return {
    ...view(context, input.now),
    published: newestPublished(context.events, context.day),
  };
}

async function projectRevisions(
  repo: Repo,
  projects: readonly string[],
): Promise<string[]> {
  const active = await repo.listActivations("project", "global", "");
  return active
    .filter((each) => projects.includes("*") || projects.includes(each.name))
    .map((each) => each.revision_id)
    .sort();
}

export function publishPlan(
  db: Db,
  input: WriteInput,
): Promise<PlanView | Refused> {
  return db.transaction(async (tx) => {
    const context = await planHost(tx, input.host, input.now);
    if (!context.ok) return context;
    const current = view(context, input.now);
    const inputs: PlanInputs = {
      host_revision: context.revision_id,
      project_revisions: await projectRevisions(tx, context.projects),
      tracker: null,
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
