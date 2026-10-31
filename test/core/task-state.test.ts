import { expect, test } from "vitest";
import {
  canMove,
  taskStates,
  TaskTransitionInvalid,
  type TaskState,
} from "../../src/core/domain/task-state.ts";

const toHold: TaskState[] = [
  "pending",
  "ready",
  "dispatched",
  "delivered",
  "passed",
  "blocked",
  "hold",
];

const specRows: [TaskState, TaskState][] = [
  ["pending", "ready"],
  ["ready", "dispatched"],
  ["ready", "delivered"],
  ["dispatched", "delivered"],
  ["dispatched", "blocked"],
  ["blocked", "dispatched"],
  ["delivered", "passed"],
  ["delivered", "hold"],
  ["delivered", "failed"],
  ["passed", "done"],
  ...toHold.map((from): [TaskState, TaskState] => [from, "hold"]),
  ["hold", "ready"],
  ["pending", "superseded"],
  ["ready", "superseded"],
  ["hold", "superseded"],
  ["dispatched", "superseded"],
  ["delivered", "superseded"],
];

const resumeRows: [TaskState, TaskState][] = [
  ["hold", "dispatched"],
  ["hold", "delivered"],
  ["hold", "blocked"],
  ["hold", "pending"],
];

test.each([...specRows, ...resumeRows])("%s -> %s is allowed", (from, to) => {
  expect(canMove(from, to)).toBe(true);
});

const refused: [TaskState, TaskState][] = [
  ["pending", "done"],
  ["failed", "ready"],
  ...taskStates.map((to): [TaskState, TaskState] => ["done", to]),
  ...taskStates.map((to): [TaskState, TaskState] => ["superseded", to]),
  ...taskStates.map((to): [TaskState, TaskState] => ["failed", to]),
];

test.each(refused)("%s -> %s is refused", (from, to) => {
  expect(canMove(from, to)).toBe(false);
});

test("no pair outside the spec and resume rows is allowed", () => {
  const allowed = new Set(
    [...specRows, ...resumeRows].map(([from, to]) => `${from}>${to}`),
  );
  for (const from of taskStates)
    for (const to of taskStates)
      expect(canMove(from, to), `${from} -> ${to}`).toBe(
        allowed.has(`${from}>${to}`),
      );
});

test("TaskTransitionInvalid names the Task, from, and to", () => {
  const error = new TaskTransitionInvalid("task_1", "done", "ready");
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("task_1");
  expect(error.message).toContain("done");
  expect(error.message).toContain("ready");
});
