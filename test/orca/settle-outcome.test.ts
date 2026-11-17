import { expect, test } from "vitest";
import { receiptOf } from "../../src/adapters/orca/receipt.ts";
import { LooseResult } from "../../src/core/ports/orca.ts";
import { settleOutcome } from "../../src/core/process/settle.ts";

function reply(exitCode: number, stdout: string) {
  return receiptOf(
    {
      verb: "task-update",
      argv: [],
      exitCode,
      signal: null,
      stdout,
      stderr: "",
      startedAt: "2026-11-17T00:00:00.000Z",
      endedAt: "2026-11-17T00:00:00.000Z",
      orcaVersion: "1.4.253",
    },
    LooseResult,
  );
}

test("exit 0 with a completed task is ok, whatever state the result names", () => {
  for (const result of [
    { task: { id: "task_1", status: "completed" } },
    { state: "completed" },
    {},
  ])
    expect(
      settleOutcome(reply(0, JSON.stringify({ ok: true, result }))),
    ).toEqual({ kind: "ok" });
});

test("exit 0 with ok false is failed", () => {
  expect(
    settleOutcome(
      reply(0, JSON.stringify({ ok: false, error: { code: "bad_status" } })),
    ),
  ).toEqual({ kind: "failed" });
});

test("exit 1 with a definite error is failed", () => {
  expect(
    settleOutcome(
      reply(
        1,
        JSON.stringify({ ok: false, error: { code: "task_not_found" } }),
      ),
    ),
  ).toEqual({ kind: "failed" });
});

test("a reply that is empty or not JSON is unknown, even on exit 0", () => {
  for (const stdout of ["", "Task task_1 [completed]", "[1]"])
    expect(settleOutcome(reply(0, stdout))).toEqual({
      kind: "unknown",
      requestId: null,
    });
});

test("a killed call or a runtime timeout is unknown and keeps its request id", () => {
  expect(settleOutcome(reply(137, ""))).toEqual({
    kind: "unknown",
    requestId: null,
  });
  expect(
    settleOutcome(
      reply(
        1,
        JSON.stringify({
          ok: false,
          error: {
            code: "runtime_timeout",
            data: { orchestrationRequestId: "req_1" },
          },
        }),
      ),
    ),
  ).toEqual({ kind: "unknown", requestId: "req_1" });
});
