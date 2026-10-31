import { expect, test } from "vitest";
import {
  HoldPayload,
  resumeTarget,
  type HeldDispatch,
} from "../../src/core/domain/hold.ts";

const running: HeldDispatch = { activity: "running", settlement: "open" };
const waiting: HeldDispatch = { activity: "waiting", settlement: "open" };
const done: HeldDispatch = { activity: "settled", settlement: "done" };
const failed: HeldDispatch = { activity: "settled", settlement: "failed" };
const stopped: HeldDispatch = { activity: "settled", settlement: "stopped" };

test("no recorded from resumes to ready whatever the Dispatch", () => {
  for (const latest of [null, running, done, stopped])
    expect(resumeTarget(undefined, latest)).toBe("ready");
});

test("from dispatched with an open running Dispatch resumes to dispatched", () => {
  expect(resumeTarget("dispatched", running)).toBe("dispatched");
});

test("from dispatched with a waiting, done, or failed Dispatch resumes to delivered", () => {
  for (const latest of [waiting, done, failed])
    expect(resumeTarget("dispatched", latest)).toBe("delivered");
});

test("from dispatched with any other settled Dispatch resumes to blocked", () => {
  expect(resumeTarget("dispatched", stopped)).toBe("blocked");
});

test("from dispatched with no Dispatch resumes to ready", () => {
  expect(resumeTarget("dispatched", null)).toBe("ready");
});

test("any other recorded state comes back as recorded", () => {
  for (const from of ["blocked", "delivered", "ready", "pending"]) {
    expect(resumeTarget(from, null)).toBe(from);
    expect(resumeTarget(from, stopped)).toBe(from);
  }
});

test("from hold, which a re-hold records, counts as no from", () => {
  for (const latest of [null, running, stopped])
    expect(resumeTarget("hold", latest)).toBe("ready");
});

test("a hold payload with a non-string from or no reason does not parse", () => {
  expect(HoldPayload.safeParse({ reason: "x", from: 3 }).success).toBe(false);
  expect(HoldPayload.safeParse({ from: "dispatched" }).success).toBe(false);
  expect(
    HoldPayload.parse({ reason: "unknown_launch", from: "ready", op_key: "k" }),
  ).toEqual({ reason: "unknown_launch", from: "ready", op_key: "k" });
});
