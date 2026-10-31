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

test("escalate and needs_evidence go to needs_human with context-missing", () => {
  for (const event of ["escalate", "needs_evidence"] as const)
    for (const n of [1, 2, 3] as const)
      expect(next(round(n), event, 3)).toEqual({
        to: { kind: "needs_human", reason: "context-missing" },
        effect: "record_outcome",
      });
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
