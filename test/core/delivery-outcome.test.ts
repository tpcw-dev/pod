import { expect, test } from "vitest";
import {
  deliveryOutcome,
  type DeliveryMatch,
} from "../../src/core/domain/delivery.ts";
import type { OrcaMessage } from "../../src/core/ports/orca.ts";

function message(
  type: string,
  payload: OrcaMessage["payload"] = { dispatchId: "ctx_1" },
): OrcaMessage {
  return { id: "msg_1", type, subject: "s", payload };
}

const live: DeliveryMatch = {
  settlement: "open",
  generation: 1,
  latest: true,
};

test("worker_done settles the Dispatch with its outcome", () => {
  expect(
    deliveryOutcome(
      message("worker_done", { dispatchId: "ctx_1", outcome: "succeeded" }),
      live,
      1,
    ),
  ).toEqual({
    kind: "delivery",
    outcome: "done",
    activity: "settled",
    settlement: "done",
  });
  expect(
    deliveryOutcome(
      message("worker_done", { dispatchId: "ctx_1", outcome: "failed" }),
      live,
      1,
    ),
  ).toEqual({
    kind: "delivery",
    outcome: "failed",
    activity: "settled",
    settlement: "failed",
  });
});

test("escalation, question, and decision_gate leave the Dispatch waiting", () => {
  for (const type of ["escalation", "question", "decision_gate"])
    expect(deliveryOutcome(message(type), live, 1)).toEqual({
      kind: "delivery",
      outcome: "waiting",
      activity: "waiting",
      settlement: "open",
    });
});

test("heartbeat, status, merge_ready, handoff, and dispatch are acked only", () => {
  for (const type of [
    "heartbeat",
    "status",
    "merge_ready",
    "handoff",
    "dispatch",
  ])
    expect(deliveryOutcome(message(type), live, 1)).toEqual({ kind: "none" });
});

test("a type or outcome zod cannot name is unknown", () => {
  expect(deliveryOutcome(message("novel"), live, 1)).toEqual({
    kind: "delivery",
    outcome: "unknown",
  });
  expect(
    deliveryOutcome(
      message("worker_done", { dispatchId: "ctx_1", outcome: "partial" }),
      live,
      1,
    ),
  ).toEqual({ kind: "delivery", outcome: "unknown" });
  expect(deliveryOutcome(message("worker_done"), live, 1)).toEqual({
    kind: "delivery",
    outcome: "unknown",
  });
});

test("a message that does not match is ignored with its reason", () => {
  expect(deliveryOutcome(message("worker_done", {}), live, 1)).toEqual({
    kind: "ignored",
    reason: "no_dispatch",
  });
  expect(deliveryOutcome(message("worker_done"), null, 1)).toEqual({
    kind: "ignored",
    reason: "unknown_dispatch",
  });
  for (const type of ["worker_done", "heartbeat"])
    expect(deliveryOutcome(message(type), live, 2)).toEqual({
      kind: "ignored",
      reason: "stale_generation",
    });
});

test("a settled or superseded Dispatch is ignored before the type table", () => {
  for (const match of [
    { ...live, settlement: "stopped" },
    { ...live, settlement: "done" },
    { ...live, latest: false },
  ])
    for (const type of ["worker_done", "escalation", "novel", "heartbeat"])
      expect(deliveryOutcome(message(type), match, 1)).toEqual({
        kind: "ignored",
        reason: "settled_dispatch",
      });
});
