import { expect, test } from "vitest";
import { argvFor } from "../../src/adapters/orca/argv.ts";
import { seatLaunch } from "../../src/core/dispatch/dispatch.ts";

test("a grok worker-start omits --model and --effort", () => {
  expect(
    argvFor.workerStart({
      task: "task_1",
      run: "run_1",
      agent: "grok",
      model: "grok-4.7",
      effort: "medium",
      worktree: "current",
    }),
  ).toEqual([
    "orchestration",
    "worker-start",
    "--task",
    "task_1",
    "--run",
    "run_1",
    "--agent",
    "grok",
    "--worktree",
    "current",
    "--json",
  ]);
});

test("another agent keeps --model and --effort", () => {
  expect(
    argvFor.workerStart({
      agent: "claude",
      model: "opus",
      effort: "medium",
    }),
  ).toEqual([
    "orchestration",
    "worker-start",
    "--agent",
    "claude",
    "--model",
    "opus",
    "--effort",
    "medium",
    "--json",
  ]);
});

test("the crew seat still names the model the argv omits", () => {
  expect(
    seatLaunch({
      id: "developer",
      roles: ["developer"],
      runtime: "grok",
      model: "grok-4.7",
      effort: "medium",
    }),
  ).toEqual({
    agent: "grok",
    model: "grok-4.7",
    effort: "medium",
    worktree: "current",
  });
});
