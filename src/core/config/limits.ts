import { z } from "zod";
import { Json } from "../domain/json.ts";

export interface DecisionLimits {
  decision_rounds: 1 | 2 | 3;
  decision_budget: Json;
}

const defaultBudget = {
  wall_clock: "2h",
  relaunches: 2,
  tool_calls: 40,
  context_tokens: "60k",
};

const Limits = z.looseObject({
  limits: z
    .looseObject({
      decision_rounds: z.unknown().optional(),
      decision_budget: z.unknown().optional(),
    })
    .optional(),
});

export function decisionLimits(policyValue: unknown): DecisionLimits {
  const limits = Limits.safeParse(policyValue).data?.limits;
  const rounds = z.int().min(1).max(3).safeParse(limits?.decision_rounds);
  const budget = z.record(z.string(), Json).safeParse(limits?.decision_budget);
  return {
    decision_rounds: rounds.success ? (rounds.data as 1 | 2 | 3) : 3,
    decision_budget: budget.success ? budget.data : defaultBudget,
  };
}
