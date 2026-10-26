import { expect, test } from "vitest";
import { freeSlots } from "../../src/core/dispatch/quota.ts";

test("one running Dispatch and one unknown reservation exhaust capacity 2", () => {
  expect(
    freeSlots(2, ["running"], [{ intent: "dispatch", status: "unknown" }]),
  ).toBe(0);
});

test("a waiting or settled Dispatch holds no slot", () => {
  expect(freeSlots(2, ["waiting", "settled", "running"], [])).toBe(1);
});

test("a pending reservation of each launch intent holds a slot", () => {
  expect(
    freeSlots(
      3,
      [],
      [
        { intent: "dispatch", status: "pending" },
        { intent: "retry", status: "unknown" },
        { intent: "decide_seat", status: "pending" },
      ],
    ),
  ).toBe(0);
});
