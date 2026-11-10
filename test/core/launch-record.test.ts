import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { fromReceipt } from "../../src/core/dispatch/launch-record.ts";
import { WorkerStartResult } from "../../src/core/ports/orca.ts";

function recorded(file: string): WorkerStartResult {
  const entry = JSON.parse(readFileSync(file, "utf8")) as { stdout: string };
  const reply = JSON.parse(entry.stdout) as { result: unknown };
  return WorkerStartResult.parse(reply.result);
}

test("a recorded worker-start names its agent terminal only in effects, and Pod records it", () => {
  const result = recorded("fixtures/orca/dogfood-b/011-worker-start.json");
  expect(result.terminalHandle).toBeUndefined();
  expect(fromReceipt(result)?.terminalHandle).toBe(
    "term_ba2a978c-9ba6-47f8-9953-8dfa693b0ad1",
  );
});

test("a top-level terminalHandle wins, and a receipt with no terminal records none", () => {
  const base = { state: "ready", dispatchId: "d-1" };
  expect(
    fromReceipt({
      ...base,
      terminalHandle: "term-top",
      effects: [{ kind: "terminal", role: "agent", id: "term-effect" }],
    })?.terminalHandle,
  ).toBe("term-top");
  expect(
    fromReceipt({
      ...base,
      effects: [{ kind: "terminal", role: "shell", id: "term-shell" }],
    })?.terminalHandle,
  ).toBeNull();
});
