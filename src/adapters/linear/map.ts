import { z } from "zod";
import type { Size } from "../../core/domain/ledger.ts";
import type {
  CommentRef,
  StoryRef,
  TrackerComment,
  TrackerStory,
} from "../../core/ports/tracker.ts";

const sizes: readonly Size[] = ["xs", "s", "m", "l", "xl"];
const scales: Readonly<Record<string, readonly number[]>> = {
  fibonacci: [1, 2, 3, 5, 8],
  tshirt: [1, 2, 3, 4, 5],
};

export function sizeOf(estimate: number | null, scale: string): Size | null {
  if (estimate === null || !Object.hasOwn(scales, scale)) return null;
  return sizes[scales[scale]?.indexOf(estimate) ?? -1] ?? null;
}

export function stageOf(labels: readonly string[]): string | null {
  const stages = labels.filter((name) => name.startsWith("stage:"));
  const [only] = stages;
  if (stages.length !== 1 || only === undefined) return null;
  const stage = only.slice("stage:".length).trim();
  return stage === "" ? null : stage;
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
