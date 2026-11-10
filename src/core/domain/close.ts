import { z } from "zod";
import { Area } from "./learning.ts";

export const P0Kind = z.enum([
  "service_broken",
  "secret_exposed",
  "data_or_money_lost",
  "main_red",
]);
export type P0Kind = z.infer<typeof P0Kind>;

const Text = z.string().min(1);

export const CloseReport = z.strictObject({
  learnings: z
    .array(
      z.strictObject({
        text: Text,
        area: Area,
        evidence_refs: z.array(Text).min(1),
      }),
    )
    .default([]),
  leftovers: z
    .array(z.strictObject({ text: Text, area: Area, p0: P0Kind.optional() }))
    .default([]),
  decisions: z.array(z.strictObject({ text: Text })).default([]),
});
export type CloseReport = z.infer<typeof CloseReport>;

export interface WorktreeStatus {
  files: string[];
  ahead: number;
}

export const ReviewedWorktree = z.object({
  path: z.string(),
  files: z.array(z.string()),
  ahead: z.int(),
});
export type ReviewedWorktree = z.infer<typeof ReviewedWorktree>;

export const KeepFilesReviewed = z.object({
  actor: z.literal("operator"),
  host: z.string(),
  worktrees: z.array(ReviewedWorktree),
});
export type KeepFilesReviewed = z.infer<typeof KeepFilesReviewed>;

export const CloseStepName = z.enum(["archive", "done"]);
export type CloseStepName = z.infer<typeof CloseStepName>;

export const CloseResult = z.object({
  run_id: z.string(),
  story: z.string(),
  state: z.literal("done"),
  owner_generation: z.int(),
  report_hash: z.string(),
  report: z.object({
    learnings: z.int(),
    leftovers: z.int(),
    decisions: z.int(),
  }),
  steps: z.array(
    z.object({
      step: CloseStepName,
      op_key: z.string(),
      status: z.literal("done"),
      replayed: z.boolean(),
    }),
  ),
  pr_events: z.array(
    z.object({ id: z.int(), ts: z.string(), payload: z.unknown() }),
  ),
  keep_files_reviewed: KeepFilesReviewed.nullable(),
  gone: z.array(z.string()),
  already_closed: z.boolean(),
  nextSteps: z.array(z.string()),
});
export type CloseResult = z.infer<typeof CloseResult>;
