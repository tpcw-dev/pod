import type { DecisionRow, DecisionState } from "../domain/decision.ts";
import type { Repo } from "../ports/db.ts";
import { recordOutcome, type Recorded } from "../process/project.ts";

export async function applyEffect(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  context: { at: Date; host: string },
): Promise<Recorded | null> {
  if (decision.effect !== "accept_plan" || decision.task_id === null)
    return null;
  if (to.kind !== "agreed" && to.kind !== "cancelled") return null;
  return recordOutcome(tx, {
    task: decision.task_id,
    outcome: to.kind,
    at: context.at,
    host: context.host,
    source: { kind: "decision", decision_id: decision.id },
  });
}
