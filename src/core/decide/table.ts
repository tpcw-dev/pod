import type { DecisionState, Round } from "../domain/decision.ts";

export type DecisionEvent =
  "open" | "agree" | "disagree" | "escalate" | "needs_evidence" | "cancel";

export type Effect =
  "send_round_open" | "send_round_next" | "record_outcome" | "hold_task";

type From =
  "requested" | "round" | "round_below_bound" | "round_at_bound" | "open";

type To = DecisionState | "next_round";

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
    from: "round",
    event: "escalate",
    to: contextMissing,
    effect: "record_outcome",
  },
  {
    from: "round",
    event: "needs_evidence",
    to: contextMissing,
    effect: "record_outcome",
  },
  {
    from: "open",
    event: "cancel",
    to: { kind: "cancelled" },
    effect: "hold_task",
  },
];

function matches(from: From, state: DecisionState, bound: number): boolean {
  switch (from) {
    case "requested":
      return state.kind === "requested";
    case "open":
      return state.kind === "requested" || state.kind === "round";
    case "round":
      return state.kind === "round" && state.n <= bound;
    case "round_below_bound":
      return state.kind === "round" && state.n < bound;
    case "round_at_bound":
      return state.kind === "round" && state.n === bound;
  }
}

export function next(
  state: DecisionState,
  event: DecisionEvent,
  bound: number,
): { to: DecisionState; effect: Effect } | null {
  const row = transitions.find(
    (item) => item.event === event && matches(item.from, state, bound),
  );
  if (row === undefined) return null;
  if (row.to !== "next_round") return { to: row.to, effect: row.effect };
  if (state.kind !== "round") return null;
  return {
    to: { kind: "round", n: (state.n + 1) as Round },
    effect: row.effect,
  };
}

export function proposalStance(
  citations: readonly string[],
): "disagree" | null {
  return citations.length === 0 ? "disagree" : null;
}
