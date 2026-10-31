import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { events, taskState } from "../db/run-fixture.ts";
import {
  applyGateConfig,
  bypassFile,
  hqa,
  receiptRows,
  recordTimeout,
  waitForJerry,
} from "./gate-scenario.ts";
import {
  check,
  scenario,
  secondCheckOrca,
  startRun,
} from "./tracker-scenario.ts";

const dir = "fixtures/tracker/edited-comment";

describeDb("edited-comment", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyGateConfig("review");
  });
  afterAll(() => conn.close());

  test(
    "an edited keeper comment voids its receipt once and holds the Run",
    async () => {
      const run = await scenario(conn, dir);
      const { orca, runId } = await startRun(conn, run, "gate-review");
      expect((await check(conn, orca, run, runId)).ok).toBe(true);
      orca.assertDone();
      const [task] = await conn.db.listTasks(runId);
      const taskId = task?.task_id ?? "";
      expect(await taskState(conn, taskId)).toBe("delivered");

      await waitForJerry("edited-comment-keeper");
      const recorded = await hqa(conn, orca, run, bypassFile());
      expect(recorded).toMatchObject({
        ok: true,
        result: { gate: "review", outcome: { state: "done" } },
      });
      const receiptId = recorded.ok ? recorded.result.receipt_id : null;
      expect(await taskState(conn, taskId)).toBe("done");

      await waitForJerry("edited-comment-edit");
      const voiding = secondCheckOrca(run.log);
      expect((await check(conn, voiding, run, runId)).ok).toBe(true);
      voiding.assertDone();
      const again = secondCheckOrca(run.log);
      expect((await check(conn, again, run, runId)).ok).toBe(true);
      again.assertDone();
      run.tracker.assertDone?.();

      expect(await receiptRows(conn)).toMatchObject([
        { id: receiptId, sync_state: "voided" },
      ]);
      expect((await conn.db.getRun(runId))?.state).toBe("hold");
      expect(await taskState(conn, taskId)).toBe("done");
      const voided = (await events(conn, "hold")).filter(
        (row) => row.payload["reason"] === "receipt_voided",
      );
      expect(voided).toEqual([
        {
          task_id: null,
          dispatch_id: null,
          payload: {
            reason: "receipt_voided",
            receipt_id: receiptId,
            from: "active",
          },
        },
        {
          task_id: taskId,
          dispatch_id: null,
          payload: {
            reason: "receipt_voided",
            receipt_id: receiptId,
            moved: false,
          },
        },
      ]);
    },
    recordTimeout,
  );
});
