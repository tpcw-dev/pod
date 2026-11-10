import { expect, test } from "vitest";
import { readDecisionMessage } from "../../src/core/domain/delivery.ts";

function proposal(fields: Record<string, unknown>) {
  return readDecisionMessage({
    id: "msg_1",
    type: "decision_gate",
    subject: "s",
    payload: {
      kind: "decision_proposal",
      dispatchId: "ctx_1",
      decisionId: "dec_1",
      round: 1,
      proposal: "the plan",
      citations: ["story:abc"],
      ...fields,
    },
  });
}

test("a proposal reads plan and changes", () => {
  expect(
    proposal({ plan: "rework", changes: ["split the migration"] }),
  ).toEqual({
    kind: "message",
    message: expect.objectContaining({
      plan: "rework",
      changes: ["split the migration"],
    }),
  });
  expect(proposal({ plan: "accept", changes: [] })).toMatchObject({
    kind: "message",
  });
  expect(proposal({})).toMatchObject({ kind: "message" });
});

test.each([
  [{ plan: "rework", changes: [] }, "rework names no changes"],
  [{ plan: "rework" }, "rework names no changes"],
  [{ plan: "accept", changes: ["one"] }, "accept carries changes"],
  [{ changes: ["one"] }, "accept carries changes"],
  [{ plan: "maybe", changes: [] }, "decision_proposal on message msg_1"],
])("proposal %j is malformed", (fields, detail) => {
  const read = proposal(fields);
  expect(read.kind).toBe("malformed");
  if (read.kind === "malformed") expect(read.detail).toContain(detail);
});
