import { z } from "zod";

export interface StateScope {
  story: string | null;
  project: string | null;
}

const stamp = {
  source_revision: z.string().nullable(),
  observed_at: z.string(),
};

const Milestone = z.object({ text: z.string(), current: z.boolean() });

export const RoadmapSection = z.discriminatedUnion("status", [
  z.object({
    ...stamp,
    status: z.literal("ok"),
    page: z.string(),
    current: z.array(z.string()),
    milestones: z.array(Milestone),
  }),
  z.object({
    ...stamp,
    status: z.enum(["no_docs_port", "no_policy", "no_roadmap", "read_failed"]),
    detail: z.string(),
  }),
]);
export type RoadmapSection = z.infer<typeof RoadmapSection>;

export const RunsSection = z.object({
  ...stamp,
  runs: z.array(
    z.object({
      run_id: z.string(),
      story: z.string(),
      state: z.string(),
      source_revision: z.string().nullable(),
      waiting_on: z.array(z.string()),
    }),
  ),
});
export type RunsSection = z.infer<typeof RunsSection>;

const RevisionRef = z.object({
  id: z.string(),
  name: z.string(),
  rev: z.int(),
});

export const PoliciesSection = z.object({
  ...stamp,
  policy: RevisionRef.nullable(),
  crew: RevisionRef.nullable(),
  reserved: z.object({
    deny: z.array(z.string()),
    needs_human: z.array(z.string()),
    needs_existing_authorization: z.array(z.string()),
  }),
});
export type PoliciesSection = z.infer<typeof PoliciesSection>;

export const DecisionsSection = z.object({
  ...stamp,
  decisions: z.array(
    z.object({
      id: z.string(),
      scope: z.string(),
      question: z.string(),
      outcome: z.string(),
      decided_at: z.string(),
      in_force_until: z.string().nullable(),
      standing: z.boolean(),
    }),
  ),
});
export type DecisionsSection = z.infer<typeof DecisionsSection>;

export const UsageSection = z.object({
  ...stamp,
  providers: z.array(
    z.object({
      provider: z.string(),
      value: z.string(),
      coverage: z.string(),
      observed_at: z.string().nullable(),
    }),
  ),
});
export type UsageSection = z.infer<typeof UsageSection>;

export const NeedsHumanSection = z.object({
  ...stamp,
  items: z.array(
    z.object({
      story: z.string(),
      run_id: z.string(),
      task_id: z.string(),
      gate: z.string(),
      keeper: z.string(),
      open: z.boolean(),
      reason: z.string(),
      at: z.string(),
    }),
  ),
});
export type NeedsHumanSection = z.infer<typeof NeedsHumanSection>;

export const LearningsSection = z.object({
  ...stamp,
  learnings: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      area: z.string(),
      source_story: z.string(),
      created_at: z.string(),
    }),
  ),
});
export type LearningsSection = z.infer<typeof LearningsSection>;

export const StateView = z.object({
  scope: z.object({
    story: z.string().nullable(),
    project: z.string().nullable(),
  }),
  roadmap: RoadmapSection,
  runs: RunsSection,
  policies: PoliciesSection,
  decisions: DecisionsSection,
  usage: UsageSection,
  needs_human: NeedsHumanSection,
  learnings: LearningsSection,
  truncated: z.boolean(),
  routing: z.array(z.string()),
});
export type StateView = z.infer<typeof StateView>;
