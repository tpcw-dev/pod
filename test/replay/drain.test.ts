import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { release } from "../../src/core/dispatch/release.ts";
import { retry } from "../../src/core/dispatch/retry.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { drain } from "../../src/core/run/drain.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/drain";
const coordinator = "term_0db4b199-e75e-4484-81b4-7487524ec679";

describeDb("drain", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/drain/${kind}.yaml`,
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

  test("no Dispatch starts under a drain, while check and release still run", async () => {
    const log = receiptLog(conn.db, "rec");
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const now = () => new Date();
    const created = await runCreate(conn.db, orca, log, {
      story: "REC-D",
      process: { name: "drain", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator,
      host: "rec",
      provider: "linear",
      command: "pod run create story:REC-D",
      now,
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const [t1, t2] = created.result.tasks.map((task) => task.task_id);
    const dispatchAs = (task: string, seat: string, opKey: string | null) =>
      dispatch(conn.db, orca, log, {
        task,
        seat,
        generation: 1,
        opKey,
        host: "rec",
        capacity: 2,
        command: (key) => `pod dispatch --op-key ${key}`,
        now,
      });
    const pass = () =>
      checkPass(conn.db, orca, log, {
        run: run_id,
        generation: 1,
        host: "rec",
        capacity: 2,
        leaseSeconds: launchLeaseSeconds,
        now,
      });
    const drainAs = (end: boolean) =>
      drain(conn.db, {
        run: run_id,
        generation: 1,
        end,
        opKey: null,
        host: "rec",
        now,
      });

    const first = await dispatchAs(t1 ?? "", "rec-a", null);
    if (!first.ok) throw new Error(first.refusal.message);
    expect(await drainAs(false)).toMatchObject({
      ok: true,
      result: { state: "drained", recorded: true },
    });
    const drainedAt = verbs.length;
    const drained = { ok: false, refusal: { code: "drained" } };
    expect(await dispatchAs(t2 ?? "", "rec-b", null)).toMatchObject(drained);
    expect(
      await retry(conn.db, orca, log, {
        dispatch: first.result.dispatch_id,
        generation: 1,
        opKey: null,
        host: "rec",
        capacity: 2,
        gitStatus: "",
        command: (key) => `pod retry --op-key ${key}`,
        now,
      }),
    ).toMatchObject(drained);
    expect(await pass()).toMatchObject({
      ok: true,
      result: { deliveries: [{ outcome: "done" }], nextSteps: [] },
    });
    expect(
      await release(conn.db, orca, log, {
        dispatch: first.result.dispatch_id,
        generation: 1,
        retain: null,
        host: "rec",
        now,
      }),
    ).toMatchObject({ ok: true, result: { state: "released" } });
    expect(await drainAs(true)).toMatchObject({
      ok: true,
      result: { state: "active", recorded: true },
    });
    const endedAt = verbs.length;
    expect(verbs.slice(drainedAt, endedAt)).toEqual([
      "check",
      "check",
      "worker-list",
      "worker-release",
    ]);

    const checked = await pass();
    if (!checked.ok) throw new Error(checked.refusal.message);
    const [step] = checked.result.nextSteps;
    const key = /--op-key (\S+)$/.exec(step ?? "")?.[1] ?? "";
    expect(step).toBe(
      `pod dispatch --task ${t2} --seat rec-b --generation 1 --op-key ${key}`,
    );
    expect(await dispatchAs(t2 ?? "", "rec-b", key)).toMatchObject({
      ok: true,
      opKey: key,
    });
    orca.assertDone();
    expect(verbs).toEqual([
      "run-create",
      "task-create",
      "task-create",
      "worker-start",
      "check",
      "check",
      "worker-list",
      "worker-release",
      "check",
      "worker-list",
      "worker-start",
    ]);
    expect(
      (
        await conn.sql<{ payload: { ended: boolean } }[]>`
          select payload from ledger.event where type = 'drain' order by id`
      ).map((row) => row.payload.ended),
    ).toEqual([false, true]);
  });

  test.todo(
    "no Decision Seat starts under a drain: S12's remainder of tech spec line 702",
  );
});
