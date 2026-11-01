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
  | { kind: "reserved_denied" }
  | { kind: "reserved_needs_human" }
  | { kind: "round"; n: Round }
  | { kind: "awaiting_evidence"; n: Round }
  | { kind: "agreed" }
  | { kind: "needs_human"; reason: NeedsHumanReason }
  | { kind: "cancelled" }
  | { kind: "superseded"; by: string };

export type DecisionReason =
  NeedsHumanReason | "agreed" | "cancelled" | "denied" | "superseded";

export const openStates = [
  "requested",
  "round:1",
  "round:2",
  "round:3",
  "awaiting_evidence:1",
  "awaiting_evidence:2",
  "awaiting_evidence:3",
];

export function stateText(state: DecisionState): string {
  return state.kind === "round" || state.kind === "awaiting_evidence"
    ? `${state.kind}:${state.n}`
    : state.kind;
}

export function reasonOf(state: DecisionState): DecisionReason | null {
  if (state.kind === "needs_human") return state.reason;
  if (state.kind === "reserved_denied") return "denied";
  if (state.kind === "agreed" || state.kind === "cancelled") return state.kind;
  return null;
}

const needsHumanReasons: readonly string[] = [
  "policy-required",
  "disagreement",
  "context-missing",
  "runtime-failure",
];

const plainStates = [
  "requested",
  "reserved_denied",
  "reserved_needs_human",
  "agreed",
  "cancelled",
] as const;

const SupersededBy = z.looseObject({ by: z.string().min(1) });

export function parseDecisionState(
  text: string,
  reason: string | null,
  outcome: Json | null = null,
): DecisionState {
  const counted = /^(round|awaiting_evidence):([123])$/.exec(text);
  if (counted !== null)
    return {
      kind: counted[1] as "round" | "awaiting_evidence",
      n: Number(counted[2]) as Round,
    };
  const plain = plainStates.find((item) => item === text);
  if (plain !== undefined) return { kind: plain };
  if (
    text === "needs_human" &&
    reason !== null &&
    needsHumanReasons.includes(reason)
  )
    return { kind: "needs_human", reason: reason as NeedsHumanReason };
  const by = SupersededBy.safeParse(outcome);
  if (text === "superseded" && by.success)
    return { kind: "superseded", by: by.data.by };
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
