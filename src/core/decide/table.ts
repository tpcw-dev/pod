import type {
  DecisionEffect,
  DecisionState,
  Round,
} from "../domain/decision.ts";

export type DecisionEvent =
  | "open"
  | "agree"
  | "disagree"
  | "escalate"
  | "needs_evidence"
  | "cancel"
  | "runtime_failure"
  | "reserved_deny"
  | "reserved_needs_human"
  | "authorized"
  | "unauthorized"
  | "policy_required"
  | "budget_exhausted"
  | "evidence"
  | "dependency_changed"
  | "ruling_resume"
  | "ruling_agreed"
  | "ruling_cancelled"
  | "supersede";

export type Effect =
  | "send_round_open"
  | "send_round_next"
  | "send_evidence_request"
  | "send_round_evidence"
  | "send_resume"
  | "record_outcome"
  | "hold_task";

type From =
  | "requested"
  | "reserved_needs_human"
  | "round"
  | "round_below_bound"
  | "round_at_bound"
  | "awaiting_evidence"
  | "needs_human"
  | "needs_human_runtime"
  | "open"
  | "open_accept_plan"
  | "agreed";

type To =
  | DecisionState
  | "next_round"
  | "awaiting_round"
  | "same_round"
  | "interrupted_round"
  | "superseded";

interface Row {
  from: From;
  event: DecisionEvent;
  to: To;
  effect: Effect;
}

const contextMissing: DecisionState = {
  kind: "needs_human",
  reason: "context-missing",
};

const runtimeFailure: DecisionState = {
  kind: "needs_human",
  reason: "runtime-failure",
};

export const transitions: readonly Row[] = [
  {
    from: "requested",
    event: "open",
    to: { kind: "round", n: 1 },
    effect: "send_round_open",
  },
  {
    from: "round",
    event: "agree",
    to: { kind: "agreed" },
    effect: "record_outcome",
  },
  {
    from: "round_below_bound",
    event: "disagree",
    to: "next_round",
    effect: "send_round_next",
  },
  {
    from: "round_at_bound",
    event: "disagree",
    to: { kind: "needs_human", reason: "disagreement" },
    effect: "record_outcome",
  },
  {
    from: "round_below_bound",
    event: "escalate",
    to: "next_round",
    effect: "send_round_next",
  },
  {
    from: "round_at_bound",
    event: "escalate",
    to: { kind: "needs_human", reason: "disagreement" },
    effect: "record_outcome",
  },
  {
    from: "round",
    event: "needs_evidence",
    to: "awaiting_round",
    effect: "send_evidence_request",
  },
  {
    from: "awaiting_evidence",
    event: "evidence",
    to: "same_round",
    effect: "send_round_evidence",
  },
  {
    from: "round",
    event: "dependency_changed",
    to: contextMissing,
    effect: "record_outcome",
  },
  {
    from: "needs_human",
    event: "dependency_changed",
    to: contextMissing,
    effect: "record_outcome",
  },
  {
    from: "needs_human_runtime",
    event: "ruling_resume",
    to: "interrupted_round",
    effect: "send_resume",
  },
  {
    from: "needs_human",
    event: "ruling_agreed",
    to: { kind: "agreed" },
    effect: "record_outcome",
  },
  {
    from: "needs_human",
    event: "ruling_cancelled",
    to: { kind: "cancelled" },
    effect: "hold_task",
  },
  {
    from: "open_accept_plan",
    event: "supersede",
    to: "superseded",
    effect: "record_outcome",
  },
  {
    from: "agreed",
    event: "supersede",
    to: "superseded",
    effect: "record_outcome",
  },
  {
    from: "open",
    event: "runtime_failure",
    to: runtimeFailure,
    effect: "record_outcome",
  },
  {
    from: "requested",
    event: "reserved_deny",
    to: { kind: "reserved_denied" },
    effect: "record_outcome",
  },
  {
    from: "requested",
    event: "reserved_needs_human",
    to: { kind: "reserved_needs_human" },
    effect: "record_outcome",
  },
  {
    from: "requested",
    event: "unauthorized",
    to: { kind: "reserved_needs_human" },
    effect: "record_outcome",
  },
  {
    from: "reserved_needs_human",
    event: "policy_required",
    to: { kind: "needs_human", reason: "policy-required" },
    effect: "record_outcome",
  },
  {
    from: "requested",
    event: "authorized",
    to: { kind: "round", n: 1 },
    effect: "send_round_open",
  },
  {
    from: "open",
    event: "budget_exhausted",
    to: runtimeFailure,
    effect: "record_outcome",
  },
  {
    from: "open",
    event: "cancel",
    to: { kind: "cancelled" },
    effect: "hold_task",
  },
];

export interface StepContext {
  effect?: DecisionEffect;
  round?: Round;
  by?: string;
}

const openKinds: readonly DecisionState["kind"][] = [
  "requested",
  "round",
  "awaiting_evidence",
];

function matches(
  from: From,
  state: DecisionState,
  bound: number,
  context: StepContext,
): boolean {
  switch (from) {
    case "requested":
      return state.kind === "requested";
    case "reserved_needs_human":
      return state.kind === "reserved_needs_human";
    case "open":
      return openKinds.includes(state.kind);
    case "open_accept_plan":
      return openKinds.includes(state.kind) && context.effect === "accept_plan";
    case "round":
      return state.kind === "round" && state.n <= bound;
    case "round_below_bound":
      return state.kind === "round" && state.n < bound;
    case "round_at_bound":
      return state.kind === "round" && state.n === bound;
    case "awaiting_evidence":
      return state.kind === "awaiting_evidence";
    case "needs_human":
      return state.kind === "needs_human";
    case "needs_human_runtime":
      return state.kind === "needs_human" && state.reason === "runtime-failure";
    case "agreed":
      return state.kind === "agreed";
  }
}

function target(
  to: To,
  state: DecisionState,
  context: StepContext,
): DecisionState | null {
  switch (to) {
    case "next_round":
      return state.kind === "round"
        ? { kind: "round", n: (state.n + 1) as Round }
        : null;
    case "awaiting_round":
      return state.kind === "round"
        ? { kind: "awaiting_evidence", n: state.n }
        : null;
    case "same_round":
      return state.kind === "awaiting_evidence"
        ? { kind: "round", n: state.n }
        : null;
    case "interrupted_round":
      return { kind: "round", n: context.round ?? 1 };
    case "superseded":
      return context.by === undefined
        ? null
        : { kind: "superseded", by: context.by };
    default:
      return to;
  }
}

export function next(
  state: DecisionState,
  event: DecisionEvent,
  bound: number,
  context: StepContext = {},
): { to: DecisionState; effect: Effect } | null {
  const row = transitions.find(
    (item) => item.event === event && matches(item.from, state, bound, context),
  );
  if (row === undefined) return null;
  const to = target(row.to, state, context);
  return to === null ? null : { to, effect: row.effect };
}

export function proposalStance(
  citations: readonly string[],
): "disagree" | null {
  return citations.length === 0 ? "disagree" : null;
}
