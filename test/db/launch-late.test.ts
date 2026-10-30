import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { retry } from "../../src/core/dispatch/retry.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { ReceiptRecord } from "../../src/core/ports/orca.ts";
import {
  fixtures,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  dispatched,
  dispatchInput,
  empty,
  events,
  freshRun,
  replay,
  started,
  taskState,
  workers,
} from "./run-fixture.ts";

const run = ["--run", "run_1"];
const failedReply: TempEntry = {
  verb: "worker-start",
  exitCode: 1,
  stdout: JSON.stringify({
    ok: false,
    error: { code: "task_not_startable", message: "no" },
  }),
};

describeDb(
  "a launch receipt that arrives after pod check closed its operation",
  () => {
    let conn: Connection;

    beforeAll(async () => {
      await resetDb();
      conn = openDb();
    });
    beforeEach(async () => {
      await freshRun(conn);
    });
    afterAll(() => conn.close());

    function racing(entries: readonly TempEntry[], listed: unknown) {
      const log = receiptLog(conn.db, "local");
      const sink = async (record: ReceiptRecord) => {
        await log.sink(record);
        if (record.verb !== "worker-start") return;
        const inner = replay(conn, [
          ok("worker-list", listed, run),
          ok("check", empty(), run),
        ]);
        const outcome = await checkPass(conn.db, inner.orca, inner.log, {
          run: "run_1",
          generation: 1,
          host: "local",
          capacity: 2,
          now: () => new Date(Date.now() + (launchLeaseSeconds + 1) * 1000),
          leaseSeconds: launchLeaseSeconds,
        });
        inner.orca.assertDone();
        if (!outcome.ok) throw new Error(outcome.refusal.message);
      };
      return {
        orca: makeReplayOrca({ dir: fixtures(entries), sink }),
        log: { ...log, sink },
      };
    }

    async function operation(intent: string) {
      const [row] = await conn.sql<
        { status: string; result_ref: Record<string, unknown> }[]
      >`select status, result_ref from ledger.operation where intent = ${intent} and status <> 'refused'`;
      return row;
    }

    test("a late start after a no-worker close records the Dispatch and leaves the operation done", async () => {
      const { orca, log } = racing(
        [ok("worker-start", started("ctx_1"))],
        workers([]),
      );
      const outcome = await dispatch(conn.db, orca, log, dispatchInput());
      expect(outcome).toMatchObject({
        ok: true,
        result: { dispatch_id: "ctx_1", task_id: "task_b" },
      });
      if (outcome.ok) expect(outcome.result).not.toHaveProperty("nextSteps");
      expect(await operation("dispatch")).toMatchObject({
        status: "done",
        result_ref: { reconciled: "lease_no_worker" },
      });
      expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
        settlement: "open",
      });
      expect(await taskState(conn, "task_b")).toBe("dispatched");
      const starts = await events(conn, "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        dispatch_id: "ctx_1",
        payload: { late: true },
      });
    });

    test("a late start on a Task already dispatched under another key names both Dispatches in nextSteps", async () => {
      const log = receiptLog(conn.db, "local");
      const sink = async (record: ReceiptRecord) => {
        await log.sink(record);
        if (record.verb !== "worker-start") return;
        const inner = replay(conn, [
          ok("worker-list", workers([]), run),
          ok("check", empty(), run),
        ]);
        const pass = await checkPass(conn.db, inner.orca, inner.log, {
          run: "run_1",
          generation: 1,
          host: "local",
          capacity: 2,
          now: () => new Date(Date.now() + (launchLeaseSeconds + 1) * 1000),
          leaseSeconds: launchLeaseSeconds,
        });
        inner.orca.assertDone();
        if (!pass.ok) throw new Error(pass.refusal.message);
        await dispatched(conn, "ctx_2", { opKey: "K2" });
      };
      const orca = makeReplayOrca({
        dir: fixtures([ok("worker-start", started("ctx_1"))]),
        sink,
      });
      const outcome = await dispatch(
        conn.db,
        orca,
        { ...log, sink },
        dispatchInput({ opKey: "K1" }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.dispatch_id).toBe("ctx_1");
      expect(outcome.result.nextSteps).toHaveLength(1);
      const [line] = outcome.result.nextSteps ?? [];
      for (const part of ["ctx_1", "K1", "ctx_2", "K2"])
        expect(line).toContain(part);
      for (const id of ["ctx_1", "ctx_2"])
        expect(await conn.db.getDispatch(id)).toMatchObject({
          settlement: "open",
        });
      expect(await taskState(conn, "task_b")).toBe("dispatched");
    });

    test("a late retry start moves the Task from blocked to dispatched", async () => {
      await dispatched(conn, "ctx_1");
      await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'stopped', settled_at = now()
      where dispatch_id = 'ctx_1'`;
      await conn.sql`update ledger.task set state = 'blocked' where task_id = 'task_b'`;
      const { orca, log } = racing(
        [ok("worker-start", started("ctx_2"))],
        workers([]),
      );
      const outcome = await retry(conn.db, orca, log, {
        dispatch: "ctx_1",
        generation: 1,
        opKey: null,
        host: "local",
        capacity: 2,
        gitStatus: "## main",
        command: (key) => `pod retry --dispatch ctx_1 --op-key ${key}`,
        now: () => new Date(),
      });
      expect(outcome).toMatchObject({
        ok: true,
        result: { dispatch_id: "ctx_2", retry_of: "ctx_1" },
      });
      if (outcome.ok) expect(outcome.result).not.toHaveProperty("nextSteps");
      expect(await operation("retry")).toMatchObject({
        status: "done",
        result_ref: { reconciled: "lease_no_worker" },
      });
      expect(await conn.db.getDispatch("ctx_2")).toMatchObject({
        retry_of: "ctx_1",
      });
      expect(await taskState(conn, "task_b")).toBe("dispatched");
      expect((await events(conn, "start")).at(-1)).toMatchObject({
        dispatch_id: "ctx_2",
        payload: { late: true, retry_of: "ctx_1" },
      });
    });

    test("a late start whose worker the pass already recorded leaves one Dispatch and one start event", async () => {
      const { orca, log } = racing(
        [ok("worker-start", started("ctx_1"))],
        workers([{ dispatchId: "ctx_1", workerState: "ready" }]),
      );
      const outcome = await dispatch(conn.db, orca, log, dispatchInput());
      expect(outcome).toMatchObject({
        ok: true,
        result: { dispatch_id: "ctx_1" },
      });
      if (outcome.ok) expect(outcome.result).not.toHaveProperty("nextSteps");
      expect(await operation("dispatch")).toMatchObject({
        status: "done",
        result_ref: { result: { dispatch_id: "ctx_1" } },
      });
      const rows = await conn.sql`
      select dispatch_id from ledger.dispatch where task_id = 'task_b'`;
      expect(rows).toHaveLength(1);
      const starts = await events(conn, "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.payload).not.toHaveProperty("late");
      expect(await taskState(conn, "task_b")).toBe("dispatched");
    });

    test("a late failed or unknown receipt leaves the operation done and returns today's refusal", async () => {
      for (const [entry, code] of [
        [failedReply, "failed"],
        [
          unknownReply("worker-start", "55555555-5555-4555-8555-555555555555"),
          "launch_unknown",
        ],
      ] as const) {
        await freshRun(conn);
        const { orca, log } = racing([entry], workers([]));
        const outcome = await dispatch(conn.db, orca, log, dispatchInput());
        expect(outcome).toMatchObject({ ok: false, refusal: { code } });
        expect(await operation("dispatch")).toMatchObject({
          status: "done",
          result_ref: { reconciled: "lease_no_worker" },
        });
        expect(await taskState(conn, "task_b")).toBe("ready");
        expect(await events(conn, "hold")).toEqual([]);
        expect(await events(conn, "start")).toEqual([]);
      }
    });
  },
);
