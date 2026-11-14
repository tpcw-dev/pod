import { z } from "zod";
import { Json } from "../domain/json.ts";
import { defaultBudgetText, parseBudget } from "../domain/policy.ts";
import type { UsageLimits } from "../domain/usage.ts";

export interface DecisionLimits {
  decision_rounds: 1 | 2 | 3;
  decision_budget: Json;
}

const Limits = z.looseObject({
  limits: z
    .looseObject({
      decision_rounds: z.unknown().optional(),
      decision_budget: z.unknown().optional(),
      usage: z.unknown().optional(),
    })
    .optional(),
});

export function decisionLimits(policyValue: unknown): DecisionLimits {
  const limits = Limits.safeParse(policyValue).data?.limits;
  const rounds = z.int().min(1).max(3).safeParse(limits?.decision_rounds);
  const budget = z.record(z.string(), Json).safeParse(limits?.decision_budget);
  return {
    decision_rounds: rounds.success ? (rounds.data as 1 | 2 | 3) : 3,
    decision_budget:
      budget.success && parseBudget(budget.data).ok
        ? budget.data
        : defaultBudgetText,
  };
}

export const UsageLimitsValue = z.strictObject({
  floor_percent: z.number().finite().min(0).max(100),
  stale_minutes: z.int().positive(),
});

export function usageLimits(policyValue: unknown): UsageLimits {
  const usage = Limits.safeParse(policyValue).data?.limits?.usage;
  return (
    UsageLimitsValue.safeParse(usage).data ?? {
      floor_percent: 50,
      stale_minutes: 30,
    }
  );
}
