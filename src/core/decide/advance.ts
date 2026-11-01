import { z } from "zod";
import {
  openStates,
  parseDecisionState,
  stateText,
  type DecisionRow,
  type DecisionState,
} from "../domain/decision.ts";
import type {
  DecisionAudit,
  DecisionEvidence,
  DecisionMessage,
  IgnoredReason,
} from "../domain/delivery.ts";
import { Json } from "../domain/json.ts";
import { budgetOf } from "../domain/policy.ts";
import type { Dispatch, Run } from "../domain/ledger.ts";
import { recordManifest } from "../manifest/record.ts";
import { ManifestReference } from "../manifest/references.ts";
import type { Repo } from "../ports/db.ts";
import {
  applyEffect,
  dependenciesUnchanged,
  specRevisionOf,
} from "./effects.ts";
import { exhausted, spentNow } from "./budget.ts";
import { appendDecisionEvent, reasonText } from "./event.ts";
import { oweSend, type FollowUp } from "./owed.ts";
import { next, proposalStance, type DecisionEvent } from "./table.ts";

export type Advanced =
  | { kind: "ignored"; reason: IgnoredReason; detail?: string }
  | { kind: "recorded"; settled: string | null };

export interface AdvanceContext {
  run: Run;
  dispatch: Dispatch;
  message: DecisionMessage;
  bound: number;
  at: Date;
  host: string;
}

const ProposalEvent = z.looseObject({
  proposal: z.string(),
  citations: z.array(z.string()),
});

const fromRole = {
  decision_proposal: "decider",
  decision_audit: "auditor",
  decision_evidence: "decider",
} as const;

export async function advanceDecision(
  tx: Repo,
  context: AdvanceContext,
): Promise<Advanced> {
  const { message, dispatch } = context;
  const decision = await tx.getDecision(message.decisionId);
  if (decision === null || decision.run_id !== context.run.run_id)
    return { kind: "ignored", reason: "out_of_turn" };
  if ((await chargeBudget(tx, decision.id, context)) !== null)
    return { kind: "ignored", reason: "settled_decision" };
  if (dispatch.role !== fromRole[message.kind])
    return { kind: "ignored", reason: "out_of_turn" };
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  const expected =
    message.kind === "decision_evidence" ? "awaiting_evidence" : "round";
  if (state.kind !== expected || !("n" in state))
    return {
      kind: "ignored",
      reason: openStates.includes(decision.state)
        ? "out_of_turn"
        : "settled_decision",
    };
  if (message.round !== state.n)
    return { kind: "ignored", reason: "out_of_turn" };
  const proposed = await proposalOf(tx, decision.id, state.n);
  if (message.kind === "decision_proposal") {
    if (proposed !== null) return { kind: "ignored", reason: "out_of_turn" };
    await owe(tx, context, decision, 0, {
      kind: "proposal",
      decision_id: decision.id,
      round: message.round,
      proposal: message.proposal,
      citations: message.citations,
    });
    return { kind: "recorded", settled: null };
  }
  if (proposed === null) return { kind: "ignored", reason: "out_of_turn" };
  if (message.kind === "decision_evidence")
    return applyEvidence(tx, context, {
      decision,
      round: state.n,
      evidence: message,
      proposal: proposed.proposal,
    });
  if (state.kind !== "round") return { kind: "ignored", reason: "out_of_turn" };
  return applyAudit(tx, context, {
    decision,
    state,
    audit: message,
    proposal: proposed.proposal,
    deciderDispatch: proposed.dispatchId,
  });
}

export async function proposalOf(
  tx: Repo,
  decisionId: string,
  round: number,
): Promise<{
  proposal: z.infer<typeof ProposalEvent>;
  dispatchId: string;
} | null> {
  const proposed = await tx.eventWith("delivery", {
    decision_id: decisionId,
    round: String(round),
    kind: "decision_proposal",
  });
  const recorded = ProposalEvent.safeParse(proposed?.payload);
  if (proposed?.dispatch_id == null || !recorded.success) return null;
  return { proposal: recorded.data, dispatchId: proposed.dispatch_id };
}

async function owe(
  tx: Repo,
  context: { run: Run; at: Date },
  decision: DecisionRow,
  attempt: number,
  followUp: FollowUp,
): Promise<void> {
  await oweSend(tx, {
    runId: decision.run_id,
    generation: context.run.owner_generation,
    followUp,
    attempt,
    at: context.at,
  });
}

const noCitation = "the proposal cites no manifest reference";

async function applyAudit(
  tx: Repo,
  context: AdvanceContext,
  input: {
    decision: DecisionRow;
    state: DecisionState & { kind: "round" };
    audit: DecisionAudit;
    proposal: z.infer<typeof ProposalEvent>;
    deciderDispatch: string;
  },
): Promise<Advanced> {
  const { decision, state, audit, proposal } = input;
  const automatic = proposalStance(proposal.citations);
  const stance = automatic ?? audit.stance;
  const reasons =
    automatic === null ? audit.reasons : [noCitation, ...audit.reasons];
  const step = next(state, stance, context.bound);
  if (step === null) return { kind: "ignored", reason: "out_of_turn" };
  if (stance === "needs_evidence")
    return requestEvidence(tx, context, {
      decision,
      to: step.to,
      round: state.n,
      deciderDispatch: input.deciderDispatch,
      audit: reasons.join("; "),
    });
  await tx.insertDecisionRound({
    decision_id: decision.id,
    round: state.n,
    decider_dispatch_id: input.deciderDispatch,
    auditor_dispatch_id: context.dispatch.dispatch_id,
    proposal: Json.parse(proposal),
    audit: Json.parse({
      stance,
      reasons,
      points_of_disagreement: audit.points_of_disagreement,
    }),
    stance,
    manifest_id: decision.manifest_id,
    ts: context.at,
  });
  if (step.effect === "send_round_next") {
    await move(tx, decision, step.to, null, null);
    await owe(tx, context, decision, 0, {
      kind: "round_next",
      decision_id: decision.id,
      round: state.n + 1,
      to: input.deciderDispatch,
      audit: reasons.join("; "),
      points_of_disagreement: audit.points_of_disagreement,
    });
    return { kind: "recorded", settled: null };
  }
  if (step.to.kind === "agreed") {
    const changed = await stale(tx, decision, state, context);
    if (changed !== null) return { kind: "recorded", settled: changed };
  }
  const text =
    step.to.kind === "agreed"
      ? proposal.proposal
      : `${stateText(step.to)}: ${reasonText(step.to)}`;
  await settle(tx, decision, step.to, text, context);
  return { kind: "recorded", settled: stateText(step.to) };
}

export async function stale(
  tx: Repo,
  decision: DecisionRow,
  state: DecisionState,
  context: { at: Date; host: string; verb?: string },
  detail: Record<string, Json> = {},
): Promise<string | null> {
  const changed = await dependenciesUnchanged(tx, decision);
  if (changed === null) return null;
  const step = next(state, "dependency_changed", 3);
  if (step === null)
    throw new Error(`the decision table has no dependency_changed row`);
  await settle(
    tx,
    decision,
    step.to,
    `${stateText(step.to)}: context-missing, ${changed} changed`,
    context,
    { ...detail, changed },
  );
  return stateText(step.to);
}

async function requestEvidence(
  tx: Repo,
  context: AdvanceContext,
  input: {
    decision: DecisionRow;
    to: DecisionState;
    round: number;
    deciderDispatch: string;
    audit: string;
  },
): Promise<Advanced> {
  const { decision } = input;
  const spent = spentNow(decision, context.at);
  const toolCalls = spent.tool_calls + 1;
  await tx.setDecisionSpent(decision.id, { ...spent, tool_calls: toolCalls });
  const settled = await chargeBudget(tx, decision.id, context);
  if (settled !== null) return { kind: "recorded", settled };
  await move(tx, decision, input.to, null, null);
  await owe(tx, context, decision, toolCalls, {
    kind: "evidence_request",
    decision_id: decision.id,
    round: input.round,
    to: input.deciderDispatch,
    audit: input.audit,
  });
  return { kind: "recorded", settled: null };
}

async function applyEvidence(
  tx: Repo,
  context: AdvanceContext,
  input: {
    decision: DecisionRow;
    round: number;
    evidence: DecisionEvidence;
    proposal: z.infer<typeof ProposalEvent>;
  },
): Promise<Advanced> {
  const { decision, evidence } = input;
  const parent = await tx.getManifest(decision.manifest_id);
  if (parent === null)
    throw new Error(`Decision ${decision.id} lost its manifest`);
  const pinned = z.array(ManifestReference).parse(parent.references);
  const known = new Set(pinned.map((row) => `${row.source}:${row.revision}`));
  const added: ManifestReference[] = [];
  for (const row of evidence.references) {
    const key = `${row.source}:${row.revision}`;
    if (known.has(key)) continue;
    known.add(key);
    added.push({
      source: row.source,
      revision: row.revision,
      observed_at: context.at.toISOString(),
      coverage: "full",
      excerpt: row.excerpt,
    });
  }
  if (added.length === 0)
    return {
      kind: "ignored",
      reason: "out_of_turn",
      detail: `decision_evidence for Decision ${decision.id} round ${input.round}: no new references`,
    };
  const { manifest } = await recordManifest(tx, {
    run_id: decision.run_id,
    task_id: decision.task_id,
    decision_id: decision.id,
    parent_id: parent.id,
    created_at: context.at,
    references: [...pinned, ...added],
  });
  if (!(await tx.setDecisionManifest(decision.id, parent.id, manifest.id)))
    throw new Error(`Decision ${decision.id} moved from manifest ${parent.id}`);
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  const step = next(state, "evidence", 3);
  if (step === null) return { kind: "ignored", reason: "out_of_turn" };
  await move(tx, decision, step.to, null, null);
  const moved = { ...decision, manifest_id: manifest.id };
  await appendDecisionEvent(tx, moved, step.to, context, {
    round: input.round,
    evidence_manifest_id: manifest.id,
    parent_manifest_id: parent.id,
    references: added.length,
  });
  const spent = spentNow(decision, context.at);
  await owe(tx, context, decision, spent.tool_calls, {
    kind: "round_evidence",
    decision_id: decision.id,
    round: input.round,
    proposal: input.proposal.proposal,
    citations: input.proposal.citations,
  });
  return { kind: "recorded", settled: null };
}

export async function move(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  outcome: Json | null,
  closedAt: Date | null,
): Promise<void> {
  const moved = await tx.updateDecisionState(decision.id, {
    from: decision.state,
    to,
    outcome,
    closed_at: closedAt,
  });
  if (!moved)
    throw new Error(`Decision ${decision.id} moved from ${decision.state}`);
}

export async function settle(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  text: string,
  context: { at: Date; host: string; verb?: string },
  detail: Record<string, Json> = {},
  outcome: Record<string, Json> = {},
): Promise<void> {
  await move(
    tx,
    decision,
    to,
    { result: to.kind, text, ...outcome },
    context.at,
  );
  const supersedes = decision.effect === "change_spec";
  if (!supersedes || to.kind !== "agreed" || "ruling" in detail)
    await appendDecisionEvent(
      tx,
      decision,
      to,
      context,
      supersedes
        ? {
            revision_id: await specRevisionOf(tx, decision),
            replacement_task_id: null,
            ...detail,
          }
        : detail,
      context.verb,
    );
  await applyEffect(tx, decision, to, context);
}

function interrupted(state: DecisionState): number {
  return state.kind === "round" || state.kind === "awaiting_evidence"
    ? state.n
    : 1;
}

export async function chargeBudget(
  tx: Repo,
  decisionId: string,
  context: { at: Date; host: string },
): Promise<string | null> {
  const decision = await tx.getDecision(decisionId);
  if (decision === null || !openStates.includes(decision.state)) return null;
  const spent = spentNow(decision, context.at);
  await tx.setDecisionSpent(decision.id, { ...spent });
  const field = exhausted(budgetOf(decision.budget), spent);
  if (field === null) return null;
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  const step = next(state, "budget_exhausted", 3);
  if (step === null) return null;
  await settle(
    tx,
    decision,
    step.to,
    `${stateText(step.to)}: runtime-failure, ${field} budget exhausted`,
    context,
    { budget_exhausted: field },
    { round: interrupted(state) },
  );
  return stateText(step.to);
}

export async function failDecision(
  tx: Repo,
  input: { decision: string; at: Date; host: string },
): Promise<boolean> {
  const decision = await tx.getDecision(input.decision);
  if (decision === null) return false;
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  const step = next(state, "runtime_failure", 3);
  if (step === null) return false;
  await settle(
    tx,
    decision,
    step.to,
    `${stateText(step.to)}: runtime-failure`,
    input,
    {},
    { round: interrupted(state) },
  );
  return true;
}

export async function cancelDecision(
  tx: Repo,
  input: {
    decision: string;
    at: Date;
    host: string;
    event?: Extract<DecisionEvent, "cancel" | "ruling_cancelled">;
    verb?: string;
    detail?: Record<string, Json>;
  },
): Promise<{ cancelled: boolean }> {
  const decision = await tx.getDecision(input.decision);
  if (decision === null) return { cancelled: false };
  const state = parseDecisionState(
    decision.state,
    decision.reason,
    decision.outcome,
  );
  const step = next(state, input.event ?? "cancel", 3);
  if (step === null) return { cancelled: false };
  await settle(tx, decision, step.to, "cancelled", input, input.detail ?? {});
  return { cancelled: true };
}
