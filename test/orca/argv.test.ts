import { expect, test } from "vitest";
import { argvFor, verbOf } from "../../src/adapters/orca/argv.ts";
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
    "--full",
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
    "--full",
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

test("worktree rm names the selector and adds --force only when asked", () => {
  const worktree = "id:repo-1::/w/one";
  expect(argvFor.worktreeRemove({ worktree, force: false })).toEqual([
    "worktree",
    "rm",
    "--worktree",
    worktree,
    "--json",
  ]);
  expect(argvFor.worktreeRemove({ worktree, force: true })).toEqual([
    "worktree",
    "rm",
    "--worktree",
    worktree,
    "--force",
    "--json",
  ]);
  expect(verbOf(argvFor.worktreeRemove({ worktree, force: false }))).toBe(
    "worktree-rm",
  );
});

test("worktree create names the project, the base branch, and no parent", () => {
  const argv = argvFor.worktreeCreate({
    project: "github:acme/widgets",
    name: "s-1",
    baseBranch: "staging",
    noParent: true,
  });
  expect(argv).toEqual([
    "worktree",
    "create",
    "--project",
    "github:acme/widgets",
    "--name",
    "s-1",
    "--base-branch",
    "staging",
    "--no-parent",
    "--json",
  ]);
  expect(verbOf(argv)).toBe("worktree-create");
});

test("worktree create without a base branch leaves the flag out", () => {
  expect(
    argvFor.worktreeCreate({
      project: "github:acme/widgets",
      name: "s-1",
      baseBranch: null,
      noParent: true,
    }),
  ).not.toContain("--base-branch");
});

test("worktree show reads one worktree by selector", () => {
  const argv = argvFor.worktreeShow({ worktree: "name:s-1" });
  expect(argv).toEqual([
    "worktree",
    "show",
    "--worktree",
    "name:s-1",
    "--json",
  ]);
  expect(verbOf(argv)).toBe("worktree-show");
});

const sender = (from?: string) => (from === undefined ? {} : { from });

const sent = {
  runCreate: (from?: string) =>
    argvFor.runCreate({ objective: "o", ...sender(from) }),
  taskCreate: (from?: string) =>
    argvFor.taskCreate({ spec: "s", run: "run_1", ...sender(from) }),
  workerStart: (from?: string) =>
    argvFor.workerStart({
      task: "task_1",
      run: "run_1",
      agent: "claude",
      ...sender(from),
    }),
  taskUpdate: (from?: string) =>
    argvFor.taskUpdate({
      task: "task_1",
      status: "completed",
      run: "run_1",
      ...sender(from),
    }),
  send: (from?: string) =>
    argvFor.send({
      to: "dispatch:ctx_1",
      subject: "s",
      body: "b",
      ...sender(from),
    }),
  reply: (from?: string) =>
    argvFor.reply({ id: "msg_1", body: "b", ...sender(from) }),
};

test("reply answers a message by id with the body", () => {
  expect(
    argvFor.reply({ id: "msg_1", body: "the answer", from: "term_coord" }),
  ).toEqual([
    "orchestration",
    "reply",
    "--id",
    "msg_1",
    "--body",
    "the answer",
    "--from",
    "term_coord",
    "--json",
    "--full",
  ]);
});

test("send names a thread only when asked, after --run", () => {
  const base = { to: "dispatch:ctx_1", subject: "s", body: "b", run: "run_1" };
  expect(argvFor.send(base)).toEqual([
    "orchestration",
    "send",
    "--to",
    "dispatch:ctx_1",
    "--subject",
    "s",
    "--body",
    "b",
    "--run",
    "run_1",
    "--json",
    "--full",
  ]);
  expect(argvFor.send({ ...base, threadId: "msg_1" }).slice(8, 12)).toEqual([
    "--run",
    "run_1",
    "--thread-id",
    "msg_1",
  ]);
});

test.each(Object.keys(sent) as (keyof typeof sent)[])(
  "%s names the sender with --from before --json",
  (verb) => {
    expect(sent[verb]("term_coord").slice(-4)).toEqual([
      "--from",
      "term_coord",
      "--json",
      "--full",
    ]);
  },
);

test.each(Object.keys(sent) as (keyof typeof sent)[])(
  "%s with no sender, or an empty one, leaves --from out",
  (verb) => {
    expect(sent[verb]()).not.toContain("--from");
    expect(sent[verb]("")).not.toContain("--from");
  },
);

test("--from comes before --retry-request on a replayed worker-start", () => {
  expect(
    argvFor
      .workerStart({
        task: "task_1",
        agent: "claude",
        from: "term_coord",
        retryRequest: "req_1",
      })
      .slice(-6),
  ).toEqual([
    "--from",
    "term_coord",
    "--retry-request",
    "req_1",
    "--json",
    "--full",
  ]);
});

test("task-update settles a task by id and status, with the retry request last", () => {
  const argv = argvFor.taskUpdate({
    task: "task_1",
    status: "completed",
    run: "run_1",
    from: "term_coord",
    retryRequest: "req_1",
  });
  expect(argv).toEqual([
    "orchestration",
    "task-update",
    "--id",
    "task_1",
    "--status",
    "completed",
    "--run",
    "run_1",
    "--from",
    "term_coord",
    "--retry-request",
    "req_1",
    "--json",
    "--full",
  ]);
  expect(verbOf(argv)).toBe("task-update");
});
