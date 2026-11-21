import { z } from "zod";
import type { Size } from "../../core/domain/ledger.ts";
import { estimateScales, sizes } from "../../core/domain/points.ts";
import type {
  CommentRef,
  ListedStory,
  StoryRef,
  TrackerComment,
  TrackerStory,
} from "../../core/ports/tracker.ts";

export function sizeOf(estimate: number | null, scale: string): Size | null {
  if (estimate === null || !Object.hasOwn(estimateScales, scale)) return null;
  return sizes[estimateScales[scale]?.indexOf(estimate) ?? -1] ?? null;
}

export function stageOf(labels: readonly string[]): string | null {
  const stages = labels.filter((name) => name.startsWith("stage:"));
  const [only] = stages;
  if (stages.length !== 1 || only === undefined) return null;
  const stage = only.slice("stage:".length).trim();
  return stage === "" ? null : stage;
}

export function driverOf(labels: readonly string[]): string | null {
  const drivers = labels.filter((name) => name.startsWith("driver:"));
  const [only] = drivers;
  if (drivers.length !== 1 || only === undefined) return null;
  const driver = only.slice("driver:".length).trim();
  return driver === "" ? null : driver;
}

export function kickoffLineOf(description: string | null): string | null {
  if (description === null) return null;
  return (
    description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("Kickoff:")) ?? null
  );
}

export function kickoffOf(
  description: string | null,
): { name: string; rev: number } | null {
  const line = kickoffLineOf(description);
  if (line === null) return null;
  const match = /^([A-Za-z0-9][\w.-]*)@([1-9][0-9]*)$/.exec(
    line.slice("Kickoff:".length).trim(),
  );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { name: match[1], rev: Number(match[2]) };
}

export const LinearIssue = z.looseObject({
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  estimate: z.number().nullish(),
  state: z.looseObject({ id: z.string(), name: z.string(), type: z.string() }),
  labels: z.looseObject({
    nodes: z.array(z.looseObject({ name: z.string() })),
  }),
  team: z.looseObject({
    states: z.looseObject({
      nodes: z.array(
        z.looseObject({ id: z.string(), name: z.string(), type: z.string() }),
      ),
    }),
  }),
});
export type LinearIssue = z.infer<typeof LinearIssue>;

const closedStates = new Set([
  "Done",
  "Story-verified",
  "Canceled",
  "Duplicate",
]);
const closedTypes = new Set(["completed", "canceled"]);

export const LinearListed = z.looseObject({
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  estimate: z.number().nullish(),
  priority: z.number(),
  createdAt: z.string().min(1),
  state: z.looseObject({ name: z.string(), type: z.string() }),
  labels: z.looseObject({
    nodes: z.array(z.looseObject({ name: z.string() })),
  }),
  projectMilestone: z.looseObject({ name: z.string() }).nullish(),
  inverseRelations: z.looseObject({
    nodes: z.array(
      z.looseObject({
        type: z.string(),
        issue: z.looseObject({
          identifier: z.string().min(1),
          state: z.looseObject({ name: z.string(), type: z.string() }),
        }),
      }),
    ),
  }),
});
export type LinearListed = z.infer<typeof LinearListed>;

export function listedOf(
  provider: string,
  issue: LinearListed,
  scale: string,
): ListedStory {
  const labels = issue.labels.nodes.map((label) => label.name);
  const estimate = issue.estimate ?? null;
  return {
    ref: { provider, external_id: issue.identifier },
    title: issue.title,
    size: sizeOf(estimate, scale),
    points: estimate,
    stageLabel: stageOf(labels),
    driverLabel: driverOf(labels),
    labels,
    priority:
      issue.priority >= 1 && issue.priority <= 4 ? issue.priority : null,
    milestone: issue.projectMilestone?.name ?? null,
    blockers: issue.inverseRelations.nodes
      .filter(
        (relation) =>
          relation.type === "blocks" &&
          !closedStates.has(relation.issue.state.name) &&
          !closedTypes.has(relation.issue.state.type),
      )
      .map((relation) => relation.issue.identifier),
    kickoffLine: kickoffOf(issue.description ?? null),
    createdAt: issue.createdAt,
  };
}

export const LinearComment = z.looseObject({
  id: z.string().min(1),
  body: z.string(),
  editedAt: z.string().nullish(),
  user: z.looseObject({ id: z.string() }).nullish(),
});
export type LinearComment = z.infer<typeof LinearComment>;

export function storyOf(
  provider: string,
  issue: LinearIssue,
  scale: string,
): TrackerStory {
  const description = issue.description ?? null;
  return {
    ref: { provider, external_id: issue.identifier },
    title: issue.title,
    stageLabel: stageOf(issue.labels.nodes.map((label) => label.name)),
    size: sizeOf(issue.estimate ?? null, scale),
    points: issue.estimate ?? null,
    kickoffLine: kickoffOf(description),
    kickoffText: kickoffLineOf(description),
    status: issue.state.name,
    statusType: issue.state.type,
  };
}

export function commentOf(
  story: StoryRef,
  comment: LinearComment,
): TrackerComment {
  const ref: CommentRef = { ...story, comment_id: comment.id };
  return {
    ref,
    authorId: comment.user?.id ?? null,
    body: comment.body,
    editedAt: comment.editedAt ?? null,
  };
}
