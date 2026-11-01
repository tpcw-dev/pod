import { z } from "zod";
import type { Json } from "./json.ts";

export type DecisionScope =
  | { kind: "global" }
  | { kind: "project"; ref: string }
  | { kind: "story"; ref: string };

export interface Decision {
  id: string;
  scope: DecisionScope;
  question: string;
  outcome: string;
  decided_at: Date;
  in_force_until: Date | null;
  standing: boolean;
}

export const Stance = z.enum([
  "agree",
  "disagree",
  "escalate",
  "needs_evidence",
]);
export type Stance = z.infer<typeof Stance>;

export const DecisionEffect = z.enum(["accept_plan", "change_spec"]);
export type DecisionEffect = z.infer<typeof DecisionEffect>;

export type Round = 1 | 2 | 3;

export type NeedsHumanReason =
  "policy-required" | "disagreement" | "context-missing" | "runtime-failure";

export type DecisionState =
  | { kind: "requested" }
  | { kind: "round"; n: Round }
  | { kind: "agreed" }
  | { kind: "needs_human"; reason: NeedsHumanReason }
  | { kind: "cancelled" };

export type DecisionReason = NeedsHumanReason | "agreed" | "cancelled";

export const openStates = ["requested", "round:1", "round:2", "round:3"];

export function stateText(state: DecisionState): string {
  return state.kind === "round" ? `round:${state.n}` : state.kind;
}

export function reasonOf(state: DecisionState): DecisionReason | null {
  if (state.kind === "needs_human") return state.reason;
  if (state.kind === "agreed" || state.kind === "cancelled") return state.kind;
  return null;
}

const needsHumanReasons: readonly string[] = [
  "policy-required",
  "disagreement",
  "context-missing",
  "runtime-failure",
];

export function parseDecisionState(
  text: string,
  reason: string | null,
): DecisionState {
  const round = /^round:([123])$/.exec(text);
  if (round !== null) return { kind: "round", n: Number(round[1]) as Round };
  if (text === "requested" || text === "agreed" || text === "cancelled")
    return { kind: text };
  if (
    text === "needs_human" &&
    reason !== null &&
    needsHumanReasons.includes(reason)
  )
    return { kind: "needs_human", reason: reason as NeedsHumanReason };
  throw new Error(
    `unknown Decision state ${text} (reason ${reason ?? "none"})`,
  );
}

export interface DecisionRow {
  id: string;
  run_id: string;
  task_id: string | null;
  category: string;
  effect: string;
  question: string;
  options: Json;
  manifest_id: string;
  state: string;
  outcome: Json | null;
  reason: string | null;
  binding: "run";
  budget: Json;
  spent: Json;
  supersedes_decision_id: string | null;
  adoption: string;
  adoption_evidence: Json;
  created_at: Date;
  closed_at: Date | null;
}

export interface DecisionRound {
  decision_id: string;
  round: number;
  decider_dispatch_id: string;
  auditor_dispatch_id: string;
  proposal: Json;
  audit: Json;
  stance: "agree" | "disagree" | "escalate";
  manifest_id: string;
  ts: Date;
}

export interface DecisionChange {
  from: string;
  to: DecisionState;
  outcome: Json | null;
  closed_at: Date | null;
}
