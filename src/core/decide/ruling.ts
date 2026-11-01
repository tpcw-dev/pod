import { z } from "zod";
import { parseDecisionState, type Round } from "../domain/decision.ts";
import type { Json } from "../domain/json.ts";
import type { Run } from "../domain/ledger.ts";
import { budgetOf } from "../domain/policy.ts";
import type { Repo } from "../ports/db.ts";
import { cancelDecision, move, settle, stale } from "./advance.ts";
import { spentNow } from "./budget.ts";
import { appendDecisionEvent } from "./event.ts";
import { oweSend } from "./owed.ts";
import { next } from "./table.ts";

export const rulingVerbs = ["resume", "agreed", "cancelled"] as const;
export type RulingVerb = (typeof rulingVerbs)[number];

export interface RulingText {
  decision_id: string;
  verb: RulingVerb;
  note: string | null;
}

export interface Ruling extends RulingText {
  comment_id: string;
  author: string;
  readback_at: string;
}

const form = /^decision (\S+) (resume|agreed|cancelled)$/;

export function parseRuling(body: string): RulingText | null {
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  const match = form.exec(lines[first]?.trim() ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const note = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  return {
    decision_id: match[1],
    verb: match[2] as RulingVerb,
    note: note === "" ? null : note,
  };
}

export function rulingText(ruling: RulingText): string {
  const head = `decision ${ruling.decision_id} ${ruling.verb}`;
  return ruling.note === null ? head : `${head}\n${ruling.note}`;
}

export async function rulingConsumed(
  repo: Pick<Repo, "eventWith">,
  decisionId: string,
  commentId: string,
): Promise<boolean> {
  return (
    (await repo.eventWith("decision", {
      decision_id: decisionId,
      ruling: { comment_id: commentId },
    })) !== null
  );
}

const Interrupted = z.looseObject({ round: z.int().min(1).max(3) });

export async function applyRuling(
  tx: Repo,
  run: Run,
  ruling: Ruling,
  context: { at: Date; host: string },
): Promise<string | null> {
  const decision = await tx.getDecision(ruling.decision_id);
  if (decision === null || decision.run_id !== run.run_id) return null;
  if (await rulingConsumed(tx, decision.id, ruling.comment_id)) return null;
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  if (state.kind !== "needs_human") return null;
  const detail: Record<string, Json> = {
    ruling: {
      comment_id: ruling.comment_id,
      author: ruling.author,
      readback_at: ruling.readback_at,
      verb: ruling.verb,
    },
  };
  if (ruling.verb === "cancelled") {
    await cancelDecision(tx, {
      decision: decision.id,
      at: context.at,
      host: context.host,
      event: "ruling_cancelled",
      detail,
    });
    return null;
  }
  if (ruling.verb === "agreed") {
    const changed = await stale(tx, decision, state, context, detail);
    if (changed !== null)
      return `Decision ${decision.id} ruling agreed is not applied: a dependency changed; the Decision is ${changed}`;
    const step = next(state, "ruling_agreed", 3);
    if (step === null) return null;
    await settle(
      tx,
      decision,
      step.to,
      ruling.note ?? "agreed by ruling",
      context,
      detail,
    );
    return null;
  }
  if (state.reason !== "runtime-failure")
    return `Decision ${decision.id} is needs_human: ${state.reason}; a resume ruling applies only to runtime-failure`;
  const spent = spentNow(decision, context.at);
  if (spent.relaunches >= budgetOf(decision.budget).relaunches) {
    await appendDecisionEvent(tx, decision, state, context, {
      ...detail,
      refused: "decision_budget_exhausted",
    });
    return `decision_budget_exhausted: Decision ${decision.id} has spent its ${spent.relaunches} relaunches; the resume ruling is refused and the Decision stays needs_human`;
  }
  const round = (Interrupted.safeParse(decision.outcome).data?.round ??
    1) as Round;
  const step = next(state, "ruling_resume", 3, { round });
  if (step === null) return null;
  const relaunches = spent.relaunches + 1;
  await tx.setDecisionSpent(decision.id, { ...spent, relaunches });
  await move(tx, decision, step.to, null, null);
  await appendDecisionEvent(tx, decision, step.to, context, {
    ...detail,
    resumed_round: round,
  });
  await oweSend(tx, {
    runId: run.run_id,
    generation: run.owner_generation,
    followUp: {
      kind: "resume",
      decision_id: decision.id,
      round,
      relaunch: relaunches,
    },
    attempt: relaunches,
    at: context.at,
  });
  return null;
}
