import { expect, test } from "vitest";
import type { DecisionState } from "../../src/core/domain/decision.ts";
import {
  next,
  proposalStance,
  transitions,
} from "../../src/core/decide/table.ts";

const round = (n: 1 | 2 | 3): DecisionState => ({ kind: "round", n });

test("requested on open goes to round 1 and sends round_open", () => {
  expect(next({ kind: "requested" }, "open", 3)).toEqual({
    to: round(1),
    effect: "send_round_open",
  });
});

test("both agree in any round goes to agreed and records the outcome", () => {
  for (const n of [1, 2, 3] as const)
    expect(next(round(n), "agree", 3)).toEqual({
      to: { kind: "agreed" },
      effect: "record_outcome",
    });
});

test("disagree below the bound goes to the next round and sends round_next", () => {
  expect(next(round(1), "disagree", 3)).toEqual({
    to: round(2),
    effect: "send_round_next",
  });
  expect(next(round(2), "disagree", 3)).toEqual({
    to: round(3),
    effect: "send_round_next",
  });
});

test("disagree at the bound of 3 goes to needs_human with disagreement", () => {
  expect(next(round(3), "disagree", 3)).toEqual({
    to: { kind: "needs_human", reason: "disagreement" },
    effect: "record_outcome",
  });
});

test("a bound of 1 sends the first disagree to needs_human", () => {
  expect(next(round(1), "disagree", 1)).toEqual({
    to: { kind: "needs_human", reason: "disagreement" },
    effect: "record_outcome",
  });
});

test("escalate counts as a disagree: next round below the bound, needs_human disagreement at it", () => {
  expect(next(round(1), "escalate", 3)).toEqual({
    to: round(2),
    effect: "send_round_next",
  });
  expect(next(round(3), "escalate", 3)).toEqual({
    to: { kind: "needs_human", reason: "disagreement" },
    effect: "record_outcome",
  });
});

test("needs_evidence moves round n to awaiting_evidence n, and evidence returns it", () => {
  for (const n of [1, 2, 3] as const) {
    expect(next(round(n), "needs_evidence", 3)).toEqual({
      to: { kind: "awaiting_evidence", n },
      effect: "send_evidence_request",
    });
    expect(next({ kind: "awaiting_evidence", n }, "evidence", 3)).toEqual({
      to: round(n),
      effect: "send_round_evidence",
    });
  }
  expect(next(round(1), "evidence", 3)).toBeNull();
});

test("a changed dependency sends a round or needs_human to context-missing", () => {
  for (const from of [
    round(2),
    { kind: "needs_human", reason: "disagreement" },
  ] satisfies DecisionState[])
    expect(next(from, "dependency_changed", 3)).toEqual({
      to: { kind: "needs_human", reason: "context-missing" },
      effect: "record_outcome",
    });
  expect(next({ kind: "agreed" }, "dependency_changed", 3)).toBeNull();
});

test("a resume ruling returns runtime-failure to the interrupted round, and nothing else", () => {
  const failed: DecisionState = {
    kind: "needs_human",
    reason: "runtime-failure",
  };
  expect(next(failed, "ruling_resume", 3, { round: 2 })).toEqual({
    to: round(2),
    effect: "send_resume",
  });
  expect(next(failed, "ruling_resume", 3)).toEqual({
    to: round(1),
    effect: "send_resume",
  });
  expect(
    next({ kind: "needs_human", reason: "disagreement" }, "ruling_resume", 3),
  ).toBeNull();
});

test("an agreed or cancelled ruling settles any needs_human", () => {
  for (const reason of [
    "policy-required",
    "disagreement",
    "context-missing",
    "runtime-failure",
  ] as const) {
    const from: DecisionState = { kind: "needs_human", reason };
    expect(next(from, "ruling_agreed", 3)).toEqual({
      to: { kind: "agreed" },
      effect: "record_outcome",
    });
    expect(next(from, "ruling_cancelled", 3)).toEqual({
      to: { kind: "cancelled" },
      effect: "hold_task",
    });
  }
  expect(next(round(1), "ruling_agreed", 3)).toBeNull();
});

test("supersede applies to an open accept_plan Decision or an agreed one", () => {
  const superseded = {
    to: { kind: "superseded", by: "dec_new" },
    effect: "record_outcome",
  };
  for (const from of [
    { kind: "requested" },
    round(2),
    { kind: "awaiting_evidence", n: 1 },
  ] satisfies DecisionState[])
    expect(
      next(from, "supersede", 3, { effect: "accept_plan", by: "dec_new" }),
    ).toEqual(superseded);
  for (const effect of ["accept_plan", "change_spec"] as const)
    expect(
      next({ kind: "agreed" }, "supersede", 3, { effect, by: "dec_new" }),
    ).toEqual(superseded);
  expect(
    next(round(2), "supersede", 3, { effect: "change_spec", by: "dec_new" }),
  ).toBeNull();
  expect(
    next({ kind: "cancelled" }, "supersede", 3, {
      effect: "accept_plan",
      by: "dec_new",
    }),
  ).toBeNull();
});

test("cancel from every open state goes to cancelled and holds the Task", () => {
  for (const from of [
    { kind: "requested" },
    round(1),
    round(2),
    round(3),
  ] as const)
    expect(next(from, "cancel", 3)).toEqual({
      to: { kind: "cancelled" },
      effect: "hold_task",
    });
});

test("a settled state has no row for any event", () => {
  const settled: DecisionState[] = [
    { kind: "agreed" },
    { kind: "cancelled" },
    { kind: "needs_human", reason: "disagreement" },
  ];
  for (const from of settled)
    for (const event of ["open", "agree", "disagree", "cancel"] as const)
      expect(next(from, event, 3)).toBeNull();
});

test("round events do not apply to requested, and open does not apply to a round", () => {
  expect(next({ kind: "requested" }, "agree", 3)).toBeNull();
  expect(next(round(1), "open", 3)).toBeNull();
});

test("a round above the bound has no disagree row", () => {
  expect(next(round(3), "disagree", 2)).toBeNull();
});

test("a proposal with no citation is an automatic disagree", () => {
  expect(proposalStance([])).toBe("disagree");
  expect(proposalStance(["manifest:story"])).toBeNull();
});

test("the table holds one row per from and event", () => {
  const keys = transitions.map((row) => `${row.from} ${row.event}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("a Reserved deny from requested goes to reserved_denied", () => {
  expect(next({ kind: "requested" }, "reserved_deny", 3)).toEqual({
    to: { kind: "reserved_denied" },
    effect: "record_outcome",
  });
});

test("a needs_human or unauthorized hit passes reserved_needs_human to needs_human policy-required", () => {
  for (const event of ["reserved_needs_human", "unauthorized"] as const)
    expect(next({ kind: "requested" }, event, 3)?.to).toEqual({
      kind: "reserved_needs_human",
    });
  expect(next({ kind: "reserved_needs_human" }, "policy_required", 3)).toEqual({
    to: { kind: "needs_human", reason: "policy-required" },
    effect: "record_outcome",
  });
});

test("an authorized hit opens round 1", () => {
  expect(next({ kind: "requested" }, "authorized", 3)).toEqual({
    to: round(1),
    effect: "send_round_open",
  });
});

test("an exhausted budget sends every open state to needs_human runtime-failure", () => {
  const open: DecisionState[] = [
    { kind: "requested" },
    round(1),
    round(3),
    { kind: "awaiting_evidence", n: 2 },
  ];
  for (const from of open)
    expect(next(from, "budget_exhausted", 3)?.to).toEqual({
      kind: "needs_human",
      reason: "runtime-failure",
    });
  for (const from of [
    { kind: "reserved_denied" },
    { kind: "agreed" },
    { kind: "needs_human", reason: "policy-required" },
  ] satisfies DecisionState[])
    expect(next(from, "budget_exhausted", 3)).toBeNull();
});

test("the Reserved rows apply only from requested", () => {
  for (const event of [
    "reserved_deny",
    "reserved_needs_human",
    "authorized",
    "unauthorized",
  ] as const)
    expect(next(round(1), event, 3)).toBeNull();
  expect(next({ kind: "requested" }, "policy_required", 3)).toBeNull();
});
