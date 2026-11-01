import { expect, test } from "vitest";
import {
  parseDecisionState,
  reasonOf,
  stateText,
  type DecisionState,
} from "../../src/core/domain/decision.ts";

test("each state's text and reason read back to the same state", () => {
  const states: DecisionState[] = [
    { kind: "requested" },
    { kind: "reserved_denied" },
    { kind: "reserved_needs_human" },
    { kind: "round", n: 2 },
    { kind: "awaiting_evidence", n: 3 },
    { kind: "agreed" },
    { kind: "needs_human", reason: "policy-required" },
    { kind: "cancelled" },
  ];
  for (const state of states)
    expect(parseDecisionState(stateText(state), reasonOf(state), null)).toEqual(
      state,
    );
  expect(stateText({ kind: "awaiting_evidence", n: 1 })).toBe(
    "awaiting_evidence:1",
  );
  expect(reasonOf({ kind: "reserved_denied" })).toBe("denied");
});

test("superseded reads by from the outcome and throws without it", () => {
  const state: DecisionState = { kind: "superseded", by: "dec_2" };
  expect(stateText(state)).toBe("superseded");
  expect(reasonOf(state)).toBe("superseded");
  expect(parseDecisionState("superseded", null, { by: "dec_2" })).toEqual(
    state,
  );
  expect(() => parseDecisionState("superseded", null, null)).toThrow(
    "unknown Decision state superseded",
  );
  expect(() => parseDecisionState("round:4", null, null)).toThrow();
});
