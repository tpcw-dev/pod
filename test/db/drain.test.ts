import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, resume } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { release } from "../../src/core/dispatch/release.ts";
import { retry } from "../../src/core/dispatch/retry.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { drain, type DrainInput } from "../../src/core/run/drain.ts";
import { noCalls, ok } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import {
  dispatched,
  dispatchInput,
  empty,
  events,
  freshRun,
  replay,
  workers,
} from "./run-fixture.ts";

const run = ["--run", "run_1"];

function input(over: Partial<DrainInput> = {}): DrainInput {
  return {
    run: "run_1",
    generation: 1,
    end: false,
    opKey: null,
    host: "local",
    now: () => new Date(),
    ...over,
  };
}

describeDb("pod drain", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  const runState = async () => (await conn.db.getRun("run_1"))?.state;
  const drainOps = () =>
    conn.sql<
      { status: string }[]
    >`select status from ledger.operation where intent = 'drain'`;

  test("drain records the event and moves active to drained; --end moves it back", async () => {
    const started = await drain(conn.db, input());
    expect(started).toMatchObject({
      ok: true,
      opKey: expect.stringMatching(/^drain:/),
      result: {
        run_id: "run_1",
        state: "drained",
        drain_in_force: true,
        ended: false,
        recorded: true,
        owner_generation: 1,
      },
    });
    expect(await runState()).toBe("drained");
    const ended = await drain(conn.db, input({ end: true }));
    expect(ended).toMatchObject({
      ok: true,
      result: { state: "active", drain_in_force: false, ended: true },
    });
    expect(await runState()).toBe("active");
    const rows = await events(conn, "drain");
    expect(rows.map((row) => row.payload)).toEqual([
      { ended: false, op_key: started.ok ? started.opKey : "" },
      { ended: true, op_key: ended.ok ? ended.opKey : "" },
    ]);
    expect((await drainOps()).map((row) => row.status)).toEqual([
      "done",
      "done",
    ]);
  });

  test("a drain in force, or an end with none, returns the state and records nothing", async () => {
    expect(await drain(conn.db, input({ end: true }))).toMatchObject({
      ok: true,
      result: { state: "active", drain_in_force: false, recorded: false },
    });
    await drain(conn.db, input());
    expect(await drain(conn.db, input())).toMatchObject({
      ok: true,
      result: { state: "drained", drain_in_force: true, recorded: false },
    });
    expect(await events(conn, "drain")).toHaveLength(1);
    expect(await drainOps()).toHaveLength(1);
  });

  test("racing drains and ends serialize on the Run: one event per change, and every reply matches the Run", async () => {
    for (let round = 0; round < 8; round += 1) {
      const end = round % 2 === 1;
      const replies = await Promise.all([
        drain(conn.db, input({ end })),
        drain(conn.db, input({ end })),
        drain(conn.db, input({ end })),
      ]);
      const want = end ? "active" : "drained";
      for (const reply of replies)
        expect(reply).toMatchObject({
          ok: true,
          result: { state: want, drain_in_force: !end },
        });
      expect(replies.filter((r) => r.ok && r.result.recorded)).toHaveLength(1);
      expect(await runState()).toBe(want);
    }
    expect(await events(conn, "drain")).toHaveLength(8);
    expect(await drainOps()).toHaveLength(8);
  });

  test("a held Run keeps hold and still records the drain", async () => {
    await conn.sql`update ledger.run set state = 'hold'`;
    expect(await drain(conn.db, input())).toMatchObject({
      ok: true,
      result: { state: "hold", drain_in_force: true, recorded: true },
    });
    expect(await runState()).toBe("hold");
    await drain(conn.db, input({ end: true }));
    expect(await runState()).toBe("hold");
    expect(await events(conn, "drain")).toHaveLength(2);
  });

  test("an unknown worker holds a drained Run, and --resume --run returns it to drained", async () => {
    await drain(conn.db, input());
    const { orca, log } = replay(conn, [
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_stray", workerState: "running" }]),
        run,
      ),
    ]);
    const pass = await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    orca.assertDone();
    expect(pass).toMatchObject({
      ok: true,
      result: { unknown_workers: ["ctx_stray"] },
    });
    expect(await runState()).toBe("hold");
    expect(
      await resume(conn.db, {
        run: "run_1",
        task: null,
        generation: 1,
        host: "local",
        now: () => new Date(),
      }),
    ).toMatchObject({ ok: true });
    expect(await runState()).toBe("drained");
  });

  test("a stale generation is owner_generation_stale, recorded refused, and moves nothing", async () => {
    expect(await drain(conn.db, input({ generation: 2 }))).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(await runState()).toBe("active");
    expect(await events(conn, "drain")).toEqual([]);
    expect((await drainOps()).map((row) => row.status)).toEqual(["refused"]);
  });

  test("no Run is task_not_ready, and a key reused for the other direction is duplicate_op", async () => {
    expect(await drain(conn.db, input({ run: "run_none" }))).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", nextSteps: ["pod brief"] },
    });
    expect(await drain(conn.db, input({ opKey: "k-1" }))).toMatchObject({
      ok: true,
      opKey: "k-1",
    });
    expect(await drain(conn.db, input({ opKey: "k-1" }))).toMatchObject({
      ok: true,
      opKey: "k-1",
      result: { ended: false, state: "drained" },
    });
    expect(
      await drain(conn.db, input({ opKey: "k-1", end: true })),
    ).toMatchObject({ ok: false, refusal: { code: "duplicate_op" } });
    await conn.db.insertOperation({
      op_key: "k-other",
      intent: "release",
      owner_generation: 1,
      at: new Date(),
    });
    expect(
      await drain(conn.db, input({ opKey: "k-other", end: true })),
    ).toMatchObject({ ok: false, refusal: { code: "duplicate_op" } });
    expect(await events(conn, "drain")).toHaveLength(1);
  });

  test("under a drain, dispatch and retry are drained with no Orca call", async () => {
    await dispatched(conn, "ctx_1");
    await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'stopped', settled_at = now()
      where dispatch_id = 'ctx_1'`;
    await conn.sql`update ledger.task set state = 'blocked' where task_id = 'task_b'`;
    await drain(conn.db, input());
    expect(await runState()).toBe("drained");
    const log = receiptLog(conn.db, "local");
    expect(
      await dispatch(
        conn.db,
        noCalls(),
        log,
        dispatchInput({ task: "task_r" }),
      ),
    ).toMatchObject({ ok: false, refusal: { code: "drained" } });
    expect(
      await retry(conn.db, noCalls(), log, {
        dispatch: "ctx_1",
        generation: 1,
        opKey: null,
        host: "local",
        capacity: 2,
        gitStatus: "## main",
        command: (opKey) => `pod retry --op-key ${opKey}`,
        now: () => new Date(),
      }),
    ).toMatchObject({ ok: false, refusal: { code: "drained" } });
  });

  test("under a drain, check and release still run, and check offers no dispatch keys", async () => {
    await dispatched(conn, "ctx_1");
    await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'done', settled_at = now()
      where dispatch_id = 'ctx_1'`;
    await conn.sql`update ledger.task set state = 'ready' where task_id = 'task_r'`;
    await drain(conn.db, input());
    await dispatch(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      dispatchInput({ task: "task_r", seat: "rev-1" }),
    );
    const checked = replay(conn, [
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "succeeded" }]),
        run,
      ),
    ]);
    const pass = await checkPass(conn.db, checked.orca, checked.log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    checked.orca.assertDone();
    expect(pass).toMatchObject({ ok: true, result: { free_slots: 2 } });
    expect(pass.ok && pass.result.nextSteps).toEqual([]);
    const released = replay(conn, [
      ok("worker-release", { dispatchId: "ctx_1", state: "released" }, [
        "--dispatch",
        "ctx_1",
      ]),
    ]);
    expect(
      await release(conn.db, released.orca, released.log, {
        dispatch: "ctx_1",
        generation: 1,
        retain: null,
        host: "local",
        now: () => new Date(),
      }),
    ).toMatchObject({ ok: true, result: { state: "released" } });
    released.orca.assertDone();
  });

  test("the CLI takes --run, --generation, and --end", () => {
    const drained = runCli(["drain", "--run", "run_1", "--generation", "1"]);
    expect(drained.status).toBe(0);
    expect(drained.json).toMatchObject({
      ok: true,
      result: { state: "drained", recorded: true },
      meta: { ownerGeneration: 1, opKey: expect.stringMatching(/^drain:/) },
    });
    const ended = runCli([
      "drain",
      "--run",
      "run_1",
      "--generation",
      "1",
      "--end",
    ]);
    expect(ended.json).toMatchObject({ ok: true, result: { state: "active" } });
    expect(runCli(["drain", "--generation", "1"]).status).toBe(2);
  });
});
