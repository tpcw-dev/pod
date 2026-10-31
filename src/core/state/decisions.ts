import type { Decision, DecisionScope } from "../domain/decision.ts";
import type { StateScope } from "../domain/state.ts";

const windowMs = 30 * 86_400_000;

function inScope(scope: DecisionScope, state: StateScope): boolean {
  if (scope.kind === "global") return true;
  if (scope.kind === "project") return scope.ref === state.project;
  return scope.ref === state.story;
}

function inForce(decision: Decision, at: Date): boolean {
  if (decision.in_force_until !== null)
    return decision.in_force_until.getTime() > at.getTime();
  return (
    decision.standing ||
    at.getTime() - decision.decided_at.getTime() <= windowMs
  );
}

export function applicableDecisions(
  decisions: readonly Decision[],
  scope: StateScope,
  at: Date,
): Decision[] {
  return decisions.filter(
    (decision) => inScope(decision.scope, scope) && inForce(decision, at),
  );
}
