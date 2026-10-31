import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/stale-dispatch-id";

describeDb("stale-dispatch-id", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/stale-dispatch-id/${kind}.yaml`,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, kind).toBe(0);
    }
  });
  afterAll(() => conn.close());

  test("a worker_done after a generation bump is recorded against its Dispatch", async () => {
    const log = receiptLog(conn.db, "rec");
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const created = await runCreate(conn.db, orca, log, {
      story: "REC-2",
      process: { name: "stale-dispatch-id", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "record",
      host: "rec",
      provider: "linear",
      command: "pod run create story:REC-2",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const task = created.result.tasks[0]?.task_id ?? "";
    const started = await dispatch(conn.db, orca, log, {
      task,
      seat: "rec-dev",
      generation: 1,
      opKey: null,
      host: "rec",
      capacity: 2,
      command: (opKey) => `pod dispatch --op-key ${opKey}`,
      now: () => new Date(),
    });
    if (!started.ok) throw new Error(started.refusal.message);
    const dispatchId = started.result.dispatch_id;

    await conn.sql`update ledger.run set owner_generation = 2`;
    const checked = await checkPass(conn.db, orca, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    orca.assertDone();
    expect(verbs).toEqual([
      "run-create",
      "task-create",
      "worker-start",
      "check",
      "check",
      "worker-list",
    ]);
    expect(checked).toMatchObject({
      ok: true,
      result: {
        deliveries: [{ dispatch_id: dispatchId, outcome: "done" }],
        ignored: 0,
        stopped: [],
        unknown_workers: [],
      },
    });
    expect(
      await conn.sql`select 1 from ledger.event where type = 'ignored'`,
    ).toHaveLength(0);
    expect(
      await conn.sql`select payload->>'outcome' as outcome, dispatch_id from ledger.event where type = 'delivery'`,
    ).toEqual([{ outcome: "done", dispatch_id: dispatchId }]);
    expect(await conn.db.getDispatch(dispatchId)).toMatchObject({
      settlement: "done",
      activity: "settled",
      requested_launch: {
        worktree: expect.stringMatching(/^id:[^:]+::\/w\/1$/),
      },
    });
    expect((await conn.db.getTask(task))?.state).toBe("done");
  });
});
