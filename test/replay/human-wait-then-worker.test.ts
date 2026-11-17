import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { ok } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "../db/fake-tracker.ts";
import { gatedRun } from "../db/gate-fixture.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { replay, started, taskState } from "../db/run-fixture.ts";

describeDb("a worker after a human wait", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("pod hqa record settles the gate's runtime task before the next worker starts", async () => {
    await gatedRun(conn, {
      gates: { pr: { keeper: "human", type: "HQA" } },
      principals: { human: { tracker_account: "keeper-1" } },
      review: "human_wait",
    });
    expect(await taskState(conn, "task_r")).toBe("ready");
    expect(await taskState(conn, "task_s")).toBe("pending");

    const tracker = fakeTracker();
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: "c-1" },
      authorId: "keeper-1",
      body: "pr PASS",
      editedAt: null,
    });
    const bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-human-wait-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-11-17T00:00:00.000Z" })}\n`,
    );
    const { orca, log } = replay(conn, [
      ok("task-update", { task: { id: "task_r", status: "completed" } }, [
        "--id",
        "task_r",
        "--status",
        "completed",
        "--run",
        "run_1",
        "--from",
        "session-1",
      ]),
      ok("worker-start", started("ctx_3", "task_s"), ["--task", "task_s"]),
    ]);

    const recorded = await recordHqa(conn.db, orca, tracker, log, {
      story: { provider: "linear", external_id: "S-1" },
      generation: 1,
      host: "local",
      hostName: "h1",
      bypassPath,
      command: "pod hqa record story:S-1 --generation 1",
      now: () => new Date(),
    });
    expect(recorded).toMatchObject({
      ok: true,
      result: {
        gate: "pr",
        outcome: { state: "done", promoted: ["task_s"] },
        nextSteps: [],
      },
    });

    const shipped = await dispatch(conn.db, orca, log, {
      task: "task_s",
      seat: "dev-1",
      generation: 1,
      opKey: null,
      host: "local",
      capacity: 2,
      command: (key) => `pod dispatch --op-key ${key}`,
      now: () => new Date(),
    });
    expect(shipped).toMatchObject({ ok: true });
    orca.assertDone();

    const calls = await conn.sql<{ verb: string; argv: string[] }[]>`
      select payload->>'verb' as verb, payload->'argv' as argv
      from ledger.event
      where type = 'receipt' and payload->>'verb' in ('task-update', 'worker-start')
      order by id`;
    expect(calls.map((call) => call.verb).slice(-2)).toEqual([
      "task-update",
      "worker-start",
    ]);
    expect(calls.at(-2)?.argv.join(" ")).toContain(
      "task-update --id task_r --status completed",
    );
    expect(calls.at(-1)?.argv).toContain("task_s");
  });
});
