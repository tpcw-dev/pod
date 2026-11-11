import { z } from "zod";

export const LearningKinds = z
  .array(z.string().regex(/^[a-z][a-z0-9_]*$/u))
  .min(1)
  .refine((kinds) => new Set(kinds).size === kinds.length, "must be distinct");

const PolicyLearning = z.looseObject({
  learning: z.looseObject({ kinds: LearningKinds }),
});

export function learningKinds(policyValue: unknown): string[] {
  return PolicyLearning.safeParse(policyValue).data?.learning.kinds ?? ["lead"];
}
