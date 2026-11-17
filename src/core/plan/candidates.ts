import { singleActive } from "../config/active.ts";
import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import type { Repo } from "../ports/db.ts";
import type { DocsPort } from "../ports/docs.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import { seatProviders, SeatsInvalid } from "../dispatch/seats.ts";
import { activeProcesses } from "../process/active.ts";
import type { ActiveProcess } from "../process/select.ts";
import { roadmapPage, roadmapSection } from "../state/sections.ts";
import { seatedProjects, type PlanHost, type SeatedProject } from "./host.ts";
import type { PlanStory } from "./rank.ts";

const launchableStatus = "Todo";
const groomStatus = "Pending-groom";

export interface PartialRead {
  project: string;
  error: string;
}

export interface Candidates {
  host_revision: string;
  project_revisions: string[];
  stories: PlanStory[];
  partial: PartialRead[];
  activations: ActiveProcess[];
  providers: Record<string, string[]>;
  tracker: { hash: string; observed_at: string } | null;
}

export interface CandidateInput {
  repo: Repo;
  tracker: TrackerPort | null;
  docs: DocsPort | null;
  context: PlanHost;
  now: Date;
}

type Current = { current: string | null } | { error: string };

async function currentMilestone(
  input: CandidateInput,
  project: string,
): Promise<Current> {
  const policy = await singleActive(input.repo, "policy", "project", project);
  if (roadmapPage(policy) === null) return { current: null };
  const { section } = await roadmapSection(
    { repo: input.repo, docs: input.docs, now: () => input.now },
    policy,
    { story: null, project },
  );
  if (section.status === "ok")
    return { current: section.current[0]?.split(" | ")[0]?.trim() ?? null };
  return { error: `roadmap: ${section.detail}` };
}

async function projectStories(
  input: CandidateInput,
  project: SeatedProject,
): Promise<{ stories: PlanStory[] } | { error: string }> {
  if (project.value === null)
    return { error: "the project Revision fails its schema" };
  if (input.tracker === null) return { error: "no tracker port" };
  const read = await input.tracker.listStories({
    project: project.value.tracker.project_id,
    status: launchableStatus,
  });
  if (!read.ok || read.result === null)
    return { error: read.error ?? "no result" };
  const current = await currentMilestone(input, project.name);
  if ("error" in current) return current;
  return {
    stories: read.result.map((story) => ({
      ...story,
      project: project.name,
      current: current.current,
    })),
  };
}

export interface GroomQueue {
  stories: { project: string; external_id: string; title: string }[];
  partial: PartialRead[];
  known: boolean;
}

export async function groomQueue(input: {
  repo: Repo;
  tracker: TrackerPort | null;
  context: PlanHost;
  project: string | null;
}): Promise<GroomQueue> {
  const queue: GroomQueue = { stories: [], partial: [], known: false };
  if (input.tracker === null) return queue;
  const seated = (await seatedProjects(input.repo, input.context)).filter(
    (each) => input.project === null || each.name === input.project,
  );
  for (const project of seated) {
    if (project.value === null) {
      queue.partial.push({
        project: project.name,
        error: "the project Revision fails its schema",
      });
      continue;
    }
    const read = await input.tracker.listStories({
      project: project.value.tracker.project_id,
      status: groomStatus,
    });
    if (!read.ok || read.result === null)
      queue.partial.push({
        project: project.name,
        error: read.error ?? "no result",
      });
    else
      queue.stories.push(
        ...read.result.map((story) => ({
          project: project.name,
          external_id: story.ref.external_id,
          title: story.title,
        })),
      );
  }
  queue.known = seated.length === 0 || queue.partial.length < seated.length;
  return queue;
}

function providersOf(crew: unknown): string[] {
  try {
    return seatProviders(crew);
  } catch (error) {
    if (error instanceof SeatsInvalid) return [];
    throw error;
  }
}

export async function crewProviders(
  repo: Repo,
  projects: readonly string[],
): Promise<Record<string, string[]>> {
  const providers: Record<string, string[]> = {};
  for (const project of projects) {
    const crew = await singleActive(repo, "crew", "project", project);
    providers[project] = crew === null ? [] : providersOf(crew.value);
  }
  return providers;
}

export async function readCandidates(
  input: CandidateInput,
): Promise<Candidates> {
  const seated = await seatedProjects(input.repo, input.context);
  const stories: PlanStory[] = [];
  const partial: PartialRead[] = [];
  for (const project of seated) {
    const read = await projectStories(input, project);
    if ("error" in read)
      partial.push({ project: project.name, error: read.error });
    else stories.push(...read.stories);
  }
  return {
    host_revision: input.context.revision_id,
    project_revisions: seated.map((each) => each.revision_id).sort(),
    stories,
    partial,
    activations: await activeProcesses(input.repo),
    providers: await crewProviders(
      input.repo,
      seated.map((each) => each.name),
    ),
    tracker:
      seated.length === 0
        ? null
        : {
            hash: sha256Hex(canonicalJson(stories)),
            observed_at: input.now.toISOString(),
          },
  };
}
