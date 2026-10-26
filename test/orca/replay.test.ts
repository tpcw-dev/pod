import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  makeReplayOrca,
  ReplayMismatch,
} from "../../src/adapters/orca/replay.ts";
import type { ReceiptRecord } from "../../src/core/ports/orca.ts";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pod-replay-"));
  const entry = (verb: string, argv: string[], result: unknown) => ({
    verb,
    match: { argv },
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    orcaVersion: "1.4.211",
    recordedAt: "2026-10-26T00:00:00Z",
  });
  writeFileSync(
    join(dir, "001-run-create.json"),
    JSON.stringify(entry("run-create", [], { run: { id: "run_1" } })),
  );
  writeFileSync(
    join(dir, "002-task-create.json"),
    JSON.stringify(
      entry("task-create", ["--run", "run_1"], {
        task: { id: "task_1", status: "ready" },
      }),
    ),
  );
  writeFileSync(join(dir, "notes.txt"), "not a fixture");
  return dir;
}

test("calls in the recorded order pass and feed the sink", async () => {
  const records: ReceiptRecord[] = [];
  const orca = makeReplayOrca({
    dir: fixtureDir(),
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
  expect(await orca.version()).toEqual({ version: "1.4.211" });
  const run = await orca.runCreate({ objective: "anything" });
  expect(run.result?.run.id).toBe("run_1");
  const task = await orca.taskCreate({ spec: "s", run: "run_1" });
  expect(task.result?.task.id).toBe("task_1");
  orca.assertDone();
  expect(records.map((record) => record.verb)).toEqual([
    "run-create",
    "task-create",
  ]);
  expect(records[1]?.argv).toEqual([
    "orchestration",
    "task-create",
    "--spec",
    "s",
    "--run",
    "run_1",
    "--json",
  ]);
});

test("an unmatched call fails with the diff", async () => {
  const orca = makeReplayOrca({ dir: fixtureDir(), sink: () => Promise.resolve() });
  await orca.runCreate({ objective: "o" });
  const error = await orca
    .taskCreate({ spec: "s", run: "run_2" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReplayMismatch);
  expect((error as Error).message).toContain(
    '- expected 002 task-create ["--run","run_1"]',
  );
  expect((error as Error).message).toContain(
    '+ actual task-create ["orchestration","task-create","--spec","s","--run","run_2","--json"]',
  );
});

test("a call of another verb fails with the diff", async () => {
  const orca = makeReplayOrca({ dir: fixtureDir(), sink: () => Promise.resolve() });
  const error = await orca
    .workerStart({ task: "task_1", agent: "claude" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReplayMismatch);
  expect((error as Error).message).toContain("- expected 001 run-create");
  expect((error as Error).message).toContain("+ actual worker-start");
});

test("an extra call fails with the diff", async () => {
  const orca = makeReplayOrca({ dir: fixtureDir(), sink: () => Promise.resolve() });
  await orca.runCreate({ objective: "o" });
  await orca.taskCreate({ spec: "s", run: "run_1" });
  const error = await orca
    .requestShow({ request: "r" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReplayMismatch);
  expect((error as Error).message).toContain("- expected nothing");
  expect((error as Error).message).toContain("+ actual request-show");
});

test("a missing call fails assertDone with the diff", async () => {
  const orca = makeReplayOrca({ dir: fixtureDir(), sink: () => Promise.resolve() });
  await orca.runCreate({ objective: "o" });
  expect(() => orca.assertDone()).toThrow(ReplayMismatch);
  expect(() => orca.assertDone()).toThrow(
    '- expected 002 task-create ["--run","run_1"]\n+ actual nothing',
  );
});
