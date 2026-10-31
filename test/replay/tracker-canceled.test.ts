import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import {
  applyConfig,
  check,
  enqueue,
  scenario,
  secondCheckOrca,
  startRun,
  trackerReceipts,
} from "./tracker-scenario.ts";

const dir = "fixtures/tracker/tracker-canceled";

describeDb("tracker-canceled", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig();
  });
  afterAll(() => conn.close());

  test("a Canceled Story cancels and holds the Run once, and a status write is acked canceled_by_human with no mutation", async () => {
    const run = await scenario(conn, dir);
    const { orca, runId } = await startRun(conn, run);
    const id = await enqueue(conn, {
      kind: "status",
      story: run.story,
      status: "Doing",
    });

    const first = await check(conn, orca, run, runId);
    orca.assertDone();
    expect(first).toMatchObject({
      ok: true,
      result: {
        nextSteps: expect.arrayContaining([
          `story:${run.story.external_id} is Canceled in the tracker; the Run is on hold`,
        ]),
      },
    });
    const again = secondCheckOrca(run.log);
    await check(conn, again, run, runId);
    again.assertDone();
    run.tracker.assertDone?.();

    expect(await trackerReceipts(conn)).toEqual([
      { verb: "readStory", operation: "Story" },
      { verb: "setStatus", operation: "Story" },
      { verb: "readStory", operation: "Story" },
    ]);
    expect(
      await conn.sql`select payload from ledger.event where type = 'cancel'`,
    ).toEqual([
      { payload: { reason: "tracker_canceled", status: "Canceled" } },
    ]);
    expect((await conn.db.getRun(runId))?.state).toBe("hold");
    expect((await conn.db.listTasks(runId)).map((task) => task.state)).toEqual([
      "hold",
    ]);
    expect(
      await conn.sql`select task_id is null as run_wide, payload->>'from' as from from ledger.event where type = 'hold' order by id`,
    ).toEqual([
      { run_wide: true, from: "active" },
      { run_wide: false, from: "dispatched" },
    ]);
    const [row] = await conn.sql<
      { acked: boolean; readback: { error: string } }[]
    >`select acked_at is not null as acked, readback from ledger.outbox where id = ${id}`;
    expect(row).toMatchObject({
      acked: true,
      readback: { error: "canceled_by_human" },
    });
  });
});
