import type { DecisionRow, DecisionState } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";

export function reasonText(state: DecisionState): string {
  return state.kind === "needs_human" ? state.reason : state.kind;
}

export async function appendDecisionEvent(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  context: { at: Date; host: string },
  effect: Record<string, Json> = {},
): Promise<void> {
  const rounds = await tx.listDecisionRounds(decision.id);
  await tx.appendEvent({
    type: "decision",
    ts: context.at,
    host: context.host,
    run_id: decision.run_id,
    task_id: decision.task_id,
    dispatch_id: null,
    op_key: null,
    payload: Json.parse({
      decision_id: decision.id,
      manifest_id: decision.manifest_id,
      rounds: rounds.length,
      outcome: to.kind,
      reason: reasonText(to),
      effect: decision.effect,
      stance_history: rounds.map((row) => ({
        round: row.round,
        stance: row.stance,
      })),
      ...effect,
    }),
    source: { kind: "command", verb: "check" },
  });
}
