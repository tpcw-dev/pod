import { singleActive } from "../config/active.ts";
import type { BriefTree } from "../domain/brief.ts";
import type { Revision } from "../domain/config.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import type { StateScope, StateView } from "../domain/state.ts";
import { seatProviders, SeatsInvalid } from "../dispatch/seats.ts";
import { fitBudget } from "./budget.ts";
import {
  decisionsSection,
  learningsSection,
  needsHumanSection,
  policiesSection,
  roadmapSection,
  runsSection,
  usageSection,
  type StateContext,
} from "./sections.ts";

export const stateBudget = 3000;

function providersOf(crews: readonly (Revision | null)[]): string[] {
  const providers = new Set<string>();
  for (const crew of crews) {
    if (crew === null) continue;
    try {
      for (const provider of seatProviders(crew.value)) providers.add(provider);
    } catch (error) {
      if (!(error instanceof SeatsInvalid)) throw error;
    }
  }
  return [...providers].sort();
}

function pinnedCrews(tree: BriefTree): (Revision | null)[] {
  return tree.stories.flatMap((story) =>
    story.runs.map((run) => run.snapshot?.crew ?? null),
  );
}

export async function buildState(
  ctx: StateContext,
  scope: StateScope,
): Promise<{ ok: true; view: StateView } | Refused> {
  const tree = await ctx.repo.readBrief(scope.story);
  if (scope.story !== null && tree.stories.length === 0)
    return refuse(
      "story_not_found",
      `no Story has external_id ${scope.story}`,
      ["pod brief"],
    );
  const [level, ref] =
    scope.project === null
      ? (["global", ""] as const)
      : (["project", scope.project] as const);
  const policy = await singleActive(ctx.repo, "policy", level, ref);
  const crew = await singleActive(ctx.repo, "crew", level, ref);
  const roadmap = await roadmapSection(ctx, policy, scope);
  const view: StateView = {
    scope,
    roadmap: roadmap.section,
    runs: await runsSection(ctx, tree),
    policies: policiesSection(ctx, policy, crew),
    decisions: await decisionsSection(ctx, scope),
    usage: await usageSection(ctx, providersOf([crew, ...pinnedCrews(tree)])),
    needs_human: await needsHumanSection(ctx, tree),
    learnings: await learningsSection(ctx, scope),
    truncated: false,
    routing: roadmap.routing,
  };
  return { ok: true, view: fitBudget(view, stateBudget) };
}
