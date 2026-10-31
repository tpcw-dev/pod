import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { relayBody } from "../bypass/relay.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { taskState } from "../db/run-fixture.ts";
import {
  applyGateConfig,
  bypassFile,
  hqa,
  receiptRows,
  recordTimeout,
  waitForJerry,
} from "./gate-scenario.ts";
import { check, scenario, startRun } from "./tracker-scenario.ts";

const dir = "fixtures/tracker/forged-author";
const verdict = "hqa_after_deploy PASS";

describeDb("forged-author", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyGateConfig("hqa");
  });
  afterAll(() => conn.close());

  test(
    "a worker's PASS is refused and the keeper's identical PASS is accepted",
    async () => {
      const run = await scenario(conn, dir);
      const { orca, runId } = await startRun(conn, run, "gate-hqa");
      expect((await check(conn, orca, run, runId)).ok).toBe(true);
      orca.assertDone();
      const [task] = await conn.db.listTasks(runId);
      const taskId = task?.task_id ?? "";
      expect(await taskState(conn, taskId)).toBe("delivered");
      await conn.db.appendEvent({
        type: "deploy",
        ts: new Date(),
        host: "rec",
        run_id: runId,
        task_id: taskId,
        dispatch_id: null,
        op_key: null,
        payload: {
          task_id: taskId,
          environment: "staging",
          deployment_id: "dep-1",
          deployed_revision: "rev-1",
          source_commit: "0123456789abcdef0123456789abcdef01234567",
        },
        source: { kind: "command", verb: "check" },
      });
      const bypass = bypassFile();

      const posted = await run.tracker.postComment({
        story: run.story,
        body: verdict,
      });
      expect(posted.ok).toBe(true);
      expect(await hqa(conn, orca, run, bypass)).toMatchObject({
        ok: false,
        refusal: {
          code: "receipt_unverified_source",
          message: expect.stringContaining("not_a_human_source"),
        },
      });
      expect(await receiptRows(conn)).toEqual([]);
      expect(await taskState(conn, taskId)).toBe("delivered");

      await waitForJerry("forged-author-keeper");
      expect(await hqa(conn, orca, run, bypass)).toMatchObject({
        ok: true,
        result: { gate: "hqa_after_deploy", outcome: { state: "done" } },
      });
      expect(await receiptRows(conn)).toMatchObject([
        {
          gate_id: "hqa_after_deploy",
          sync_state: "synced",
          deployed_revision: "rev-1",
        },
      ]);
      expect(await taskState(conn, taskId)).toBe("done");
      expect(relayBody(null, "PASS")).toBeNull();
      run.tracker.assertDone?.();
    },
    recordTimeout,
  );
});
