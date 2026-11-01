import { z } from "zod";
import type { DecisionRow } from "../domain/decision.ts";
import {
  budgetFields,
  type Budget,
  type BudgetField,
} from "../domain/policy.ts";

export type Spent = Budget;

const count = z.int().nonnegative().catch(0);

const Stored = z
  .looseObject({
    relaunches: count,
    tool_calls: count,
    context_tokens: count,
  })
  .catch({ relaunches: 0, tool_calls: 0, context_tokens: 0 });

export function spentNow(decision: DecisionRow, now: Date): Spent {
  const stored = Stored.parse(decision.spent);
  const elapsed = Math.floor(
    (now.getTime() - decision.created_at.getTime()) / 1000,
  );
  return {
    wall_clock: Math.max(0, elapsed),
    relaunches: stored.relaunches,
    tool_calls: stored.tool_calls,
    context_tokens: stored.context_tokens,
  };
}

export function exhausted(budget: Budget, spent: Spent): BudgetField | null {
  return budgetFields.find((field) => spent[field] > budget[field]) ?? null;
}
