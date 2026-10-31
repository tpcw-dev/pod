import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import {
  dispatch,
  type DispatchInput,
} from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/capacity-1";

describeDb("capacity-1", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/capacity-1/${kind}.yaml`,
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

  test("the second Task waits for the slot, and pod check prints the key that dispatches it", async () => {
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
      story: "REC-3",
      process: { name: "capacity-1", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "record",
      host: "rec",
      provider: "linear",
      command: "pod run create story:REC-3",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const [a, b] = created.result.tasks.map((task) => task.task_id);
    const input = (task: string, seat: string, opKey: string | null) =>
      ({
        task,
        seat,
        generation: 1,
        opKey,
        host: "rec",
        capacity: 1,
        command: (key) => `pod dispatch --op-key ${key}`,
        now: () => new Date(),
      }) satisfies DispatchInput;

    const first = await dispatch(
      conn.db,
      orca,
      log,
      input(a ?? "", "rec-a", null),
    );
    expect(first).toMatchObject({ ok: true });
    const waiting = await dispatch(
      conn.db,
      orca,
      log,
      input(b ?? "", "rec-b", null),
    );
    expect(waiting).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });

    const checked = await checkPass(conn.db, orca, log, {
      run: run_id,
      generation: 1,
      host: "rec",
      capacity: 1,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    expect(checked).toMatchObject({
      ok: true,
      result: { deliveries: [{ outcome: "done" }], free_slots: 1 },
    });
    if (!checked.ok) return;
    const [step] = checked.result.nextSteps;
    const key = /--op-key (\S+)$/.exec(step ?? "")?.[1] ?? "";
    expect(step).toBe(
      `pod dispatch --task ${b} --seat rec-b --generation 1 --op-key ${key}`,
    );

    const second = await dispatch(
      conn.db,
      orca,
      log,
      input(b ?? "", "rec-b", key),
    );
    expect(second).toMatchObject({ ok: true, opKey: key });
    orca.assertDone();
    expect(verbs).toEqual([
      "run-create",
      "task-create",
      "task-create",
      "worker-start",
      "check",
      "check",
      "worker-list",
      "worker-start",
    ]);
    const rows = await conn.sql<
      { task_id: string; settlement: string; activity: string }[]
    >`select task_id, settlement, activity from ledger.dispatch order by created_at`;
    expect(rows).toEqual([
      { task_id: a, settlement: "done", activity: "settled" },
      { task_id: b, settlement: "open", activity: "running" },
    ]);
    expect((await conn.db.getTask(a ?? ""))?.state).toBe("done");
    expect((await conn.db.getTask(b ?? ""))?.state).toBe("dispatched");
  });
});
