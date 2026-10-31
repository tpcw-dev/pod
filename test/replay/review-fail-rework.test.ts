import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { applyOutcome } from "../../src/core/process/project.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/review-fail-rework";
const host = "podrec";

describeDb("review-fail-rework", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/review-fail-rework/${kind}.yaml`,
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

  test("a review FAIL reworks implement and review in their lineages, once, and the second FAIL holds at the limit", async () => {
    const log = receiptLog(conn.db, host);
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const created = await runCreate(conn.db, orca, null, log, {
      story: "S5B-9",
      process: { name: "review-fail-rework", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "record",
      host,
      provider: "linear",
      command: "pod run create story:S5B-9",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const [implement, review, pr] = created.result.tasks.map(
      (task) => task.task_id,
    ) as [string, string, string];
    const start = async (task: string, seat: string) => {
      const started = await dispatch(conn.db, orca, log, {
        task,
        seat,
        generation: 1,
        opKey: null,
        host,
        capacity: 1,
        command: (key) => `pod dispatch --op-key ${key}`,
        now: () => new Date(),
      });
      expect(started, task).toMatchObject({ ok: true });
    };
    const check = async () => {
      const checked = await checkPass(conn.db, orca, null, log, {
        run: run_id,
        generation: 1,
        host,
        capacity: 1,
        leaseSeconds: launchLeaseSeconds,
        now: () => new Date(),
      });
      expect(checked).toMatchObject({
        ok: true,
        result: { deliveries: [{ outcome: "done" }] },
      });
    };
    const fail = (task: string) =>
      applyOutcome(conn.db, orca, log, {
        task,
        outcome: "FAIL",
        at: new Date(),
        host,
        source: { kind: "command", verb: "test" },
        command: "pod verdict post",
        now: () => new Date(),
      });
    const task = async (id: string) => {
      const row = await conn.db.getTask(id);
      if (row === null) throw new Error(`no Task ${id}`);
      return row;
    };

    await start(implement, "rec-dev");
    await check();
    expect((await task(implement)).state).toBe("done");
    expect((await task(review)).state).toBe("ready");
    await start(review, "rec-rev");
    await check();
    expect((await task(review)).state).toBe("delivered");
    expect((await task(pr)).state).toBe("pending");

    const first = await fail(review);
    if (!first.ok) throw new Error(first.refusal.message);
    const [implement2, review2] = first.result.created as [string, string];
    expect(first.result).toMatchObject({ state: "failed", replayed: false });
    expect(first.result.created).toHaveLength(2);
    expect(await task(review)).toMatchObject({ state: "failed" });
    expect(await task(implement2)).toMatchObject({
      step_id: "implement",
      lineage_id: `${run_id}:implement`,
      rework_of: implement,
      state: "ready",
    });
    expect(await task(review2)).toMatchObject({
      step_id: "review",
      lineage_id: `${run_id}:review`,
      rework_of: review,
      deps: [implement2],
      state: "pending",
    });
    expect(await task(pr)).toMatchObject({ state: "pending", deps: [review2] });

    expect(await fail(review)).toMatchObject({
      ok: true,
      result: { created: [implement2, review2], replayed: true },
    });
    expect(verbs.filter((verb) => verb === "task-create")).toHaveLength(5);

    await start(implement2, "rec-dev");
    await check();
    expect((await task(implement2)).state).toBe("done");
    expect((await task(review2)).state).toBe("ready");
    await start(review2, "rec-rev");
    await check();
    expect((await task(review2)).state).toBe("delivered");

    expect(await fail(review2)).toMatchObject({
      ok: true,
      result: { state: "hold", created: [] },
    });
    expect((await task(review2)).state).toBe("hold");
    expect(
      await conn.db.latestEvent(run_id, "hold", { taskId: review2 }),
    ).toMatchObject({
      payload: {
        reason: "rework_limit",
        lineage_id: `${run_id}:implement`,
        from: "delivered",
      },
    });
    expect(await conn.db.listTasks(run_id)).toHaveLength(5);
    expect(verbs.filter((verb) => verb === "task-create")).toHaveLength(5);
    expect((await task(pr)).state).toBe("pending");
    orca.assertDone();
  });
});
