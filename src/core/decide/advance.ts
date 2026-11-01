import { z } from "zod";
import {
  parseDecisionState,
  stateText,
  type DecisionRow,
  type DecisionState,
} from "../domain/decision.ts";
import type {
  DecisionAudit,
  DecisionMessage,
  DecisionProposal,
  IgnoredReason,
} from "../domain/delivery.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch, Run } from "../domain/ledger.ts";
import {
  openDecisionSeat,
  type ReceiptLog,
} from "../dispatch/decision-seats.ts";
import { ManifestReference, manifestText } from "../manifest/references.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { applyEffect, specRevisionOf } from "./effects.ts";
import { appendDecisionEvent, reasonText } from "./event.ts";
import { next, proposalStance } from "./table.ts";
import { optionsText, renderTemplate, type Templates } from "./templates.ts";

export type FollowUp =
  | {
      kind: "proposal";
      decision_id: string;
      round: number;
      proposal: string;
      citations: string[];
    }
  | {
      kind: "round_next";
      decision_id: string;
      round: number;
      to: string;
      audit: string;
      points_of_disagreement: string[];
    };

export type Advanced =
  | { kind: "ignored"; reason: IgnoredReason }
  | { kind: "recorded"; followUps: FollowUp[]; settled: string | null };

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
} as const;

export async function advanceDecision(
  tx: Repo,
  context: AdvanceContext,
): Promise<Advanced> {
  const { message, dispatch } = context;
  const decision = await tx.getDecision(message.decisionId);
  if (decision === null || decision.run_id !== context.run.run_id)
    return { kind: "ignored", reason: "out_of_turn" };
  if (dispatch.role !== fromRole[message.kind])
    return { kind: "ignored", reason: "out_of_turn" };
  const state = parseDecisionState(decision.state, decision.reason);
  if (state.kind !== "round")
    return {
      kind: "ignored",
      reason: state.kind === "requested" ? "out_of_turn" : "settled_decision",
    };
  if (message.round !== state.n)
    return { kind: "ignored", reason: "out_of_turn" };
  const proposed = await tx.eventWith("delivery", {
    decision_id: decision.id,
    round: String(state.n),
    kind: "decision_proposal",
  });
  if (message.kind === "decision_proposal") {
    if (proposed !== null) return { kind: "ignored", reason: "out_of_turn" };
    return {
      kind: "recorded",
      followUps: [proposalFollowUp(decision, message)],
      settled: null,
    };
  }
  const recorded = ProposalEvent.safeParse(proposed?.payload);
  if (proposed?.dispatch_id == null || !recorded.success)
    return { kind: "ignored", reason: "out_of_turn" };
  return applyAudit(tx, context, {
    decision,
    state,
    audit: message,
    proposal: recorded.data,
    deciderDispatch: proposed.dispatch_id,
  });
}

function proposalFollowUp(
  decision: DecisionRow,
  message: DecisionProposal,
): FollowUp {
  return {
    kind: "proposal",
    decision_id: decision.id,
    round: message.round,
    proposal: message.proposal,
    citations: message.citations,
  };
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
  if (stance !== "needs_evidence")
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
    return {
      kind: "recorded",
      followUps: [
        {
          kind: "round_next",
          decision_id: decision.id,
          round: state.n + 1,
          to: input.deciderDispatch,
          audit: reasons.join("; "),
          points_of_disagreement: audit.points_of_disagreement,
        },
      ],
      settled: null,
    };
  }
  const text =
    step.to.kind === "agreed"
      ? proposal.proposal
      : `${stateText(step.to)}: ${reasonText(step.to)}`;
  await settle(tx, decision, step.to, text, context);
  return { kind: "recorded", followUps: [], settled: stateText(step.to) };
}

async function move(
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

async function settle(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  text: string,
  context: { at: Date; host: string },
): Promise<void> {
  await move(tx, decision, to, { result: to.kind, text }, context.at);
  const supersedes = decision.effect === "change_spec";
  if (!supersedes || to.kind !== "agreed")
    await appendDecisionEvent(
      tx,
      decision,
      to,
      context,
      supersedes
        ? {
            revision_id: await specRevisionOf(tx, decision),
            replacement_task_id: null,
          }
        : {},
    );
  await applyEffect(tx, decision, to, context);
}

export async function failDecision(
  tx: Repo,
  input: { decision: string; at: Date; host: string },
): Promise<boolean> {
  const decision = await tx.getDecision(input.decision);
  if (decision === null) return false;
  const state = parseDecisionState(decision.state, decision.reason);
  const step = next(state, "runtime_failure", 3);
  if (step === null) return false;
  await settle(tx, decision, step.to, `${stateText(step.to)}: runtime-failure`, input);
  return true;
}

export async function cancelDecision(
  tx: Repo,
  input: { decision: string; at: Date; host: string },
): Promise<{ cancelled: boolean }> {
  const decision = await tx.getDecision(input.decision);
  if (decision === null) return { cancelled: false };
  const state = parseDecisionState(decision.state, decision.reason);
  const step = next(state, "cancel", 3);
  if (step === null) return { cancelled: false };
  await settle(tx, decision, step.to, "cancelled", input);
  return { cancelled: true };
}

export interface FollowContext {
  run: Run;
  templates: Templates | null;
  generation: number;
  host: string;
  capacity: number;
  now: () => Date;
}

export async function followDecisions(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  followUps: readonly FollowUp[],
  context: FollowContext,
): Promise<string[]> {
  const steps: string[] = [];
  for (const item of followUps) {
    const decision = await db.getDecision(item.decision_id);
    if (decision === null) continue;
    const to = await recipient(db, orca, log, item, decision, context);
    if (typeof to !== "string") {
      steps.push(
        `Decision ${decision.id} round ${item.round}: ${to.message}; run pod check again`,
      );
      continue;
    }
    log.at({
      run_id: decision.run_id,
      task_id: decision.task_id,
      op_key: null,
    });
    const sent = await orca.send({
      to: `dispatch:${to}`,
      subject: `decision ${decision.id} round ${item.round}${item.kind === "proposal" ? " proposal" : ""}`,
      body: bodyOf(item, decision, context.templates),
    });
    if (sent.exitCode === 0) await db.setDispatchActivity(to, "running");
    else
      steps.push(
        `send of Decision ${decision.id} round ${item.round} to Dispatch ${to} failed; Dispatch ${to} stays waiting`,
      );
  }
  return steps;
}

async function recipient(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  item: FollowUp,
  decision: DecisionRow,
  context: FollowContext,
): Promise<string | { message: string }> {
  if (item.kind === "round_next") return item.to;
  const manifest = await db.getManifest(decision.manifest_id);
  const fields = fieldsOf(decision, manifest?.references ?? []);
  if (context.templates === null)
    return { message: "no active decision Revision to render the auditor" };
  const seat = await openDecisionSeat(db, orca, log, {
    run: context.run,
    decisionId: decision.id,
    role: "auditor",
    spec: renderTemplate(context.templates.auditor, fields),
    manifestId: decision.manifest_id,
    generation: context.generation,
    host: context.host,
    capacity: context.capacity,
    now: context.now,
  });
  if (seat.ok) return seat.dispatch.dispatch_id;
  if (seat.runtimeFailure === true) {
    await db.transaction((tx) =>
      failDecision(tx, {
        decision: decision.id,
        at: context.now(),
        host: context.host,
      }),
    );
    return {
      message: `${seat.refusal.code} ${seat.refusal.message}; Decision ${decision.id} is needs_human: runtime-failure`,
    };
  }
  return { message: `${seat.refusal.code} ${seat.refusal.message}` };
}

function fieldsOf(decision: DecisionRow, references: Json) {
  const parsed = z.array(ManifestReference).safeParse(references);
  return {
    decision_id: decision.id,
    question: decision.question,
    options: optionsText(z.array(z.string()).parse(decision.options)),
    manifest_id: decision.manifest_id,
    manifest: parsed.success ? manifestText(parsed.data) : "",
  };
}

function bodyOf(
  item: FollowUp,
  decision: DecisionRow,
  templates: Templates | null,
): string {
  if (item.kind === "proposal")
    return [
      `Decision ${decision.id} round ${item.round}. Audit this proposal.`,
      "",
      `Question: ${decision.question}`,
      `Proposal: ${item.proposal}`,
      `Citations: ${item.citations.length === 0 ? "none" : item.citations.join(", ")}`,
    ].join("\n");
  const points = item.points_of_disagreement.map((point) => `- ${point}`);
  return renderTemplate(templates?.round_next ?? "{{audit}}", {
    decision_id: decision.id,
    round: String(item.round),
    audit: item.audit,
    points_of_disagreement: points.join("\n"),
  });
}
