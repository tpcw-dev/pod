import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkWait, type WaitInput } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { derivedOpKey } from "../../src/core/ledger/op-key.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  batch,
  dispatched,
  dispatchInput,
  empty,
  freshRun,
  message,
  replay,
  started,
  workers,
} from "./run-fixture.ts";

const run = ["--run", "run_1"];
const ack = (id: string) => ["--run", "run_1", "--ack", id];

describeDb("pod check --wait", () => {
  let conn: Connection;
  let clock: number;
  let slept: number[];

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await dispatched(conn, "ctx_1");
    clock = Date.parse("2026-10-26T00:00:00Z");
    slept = [];
  });
  afterAll(() => conn.close());

  function input(over: Partial<WaitInput> = {}): WaitInput {
    return {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 1,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(clock),
      interval: 10,
      timeout: 25,
      sleep: (seconds) => {
        slept.push(seconds);
        clock += seconds * 1000;
        return Promise.resolve();
      },
      ...over,
    };
  }

  async function wait(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkWait(conn.db, orca, null, log, input());
    orca.assertDone();
    return outcome;
  }

  const quiet = [
    ok("check", empty(), run),
    ok(
      "worker-list",
      workers([{ dispatchId: "ctx_1", workerState: "ready" }]),
      run,
    ),
  ];
  const done = (id: string) =>
    message(id, "worker_done", { dispatchId: "ctx_1", outcome: "succeeded" });

  test("a delivery on the second poll ends the wait", async () => {
    const outcome = await wait([
      ...quiet,
      ok("check", batch("delivery_1", [done("msg_1")]), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "succeeded" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { deliveries: [{ message_id: "msg_1" }], free_slots: 1 },
    });
    expect(slept).toEqual([10]);
  });

  test("the timeout is failed with the seconds waited", async () => {
    const outcome = await wait([...quiet, ...quiet, ...quiet, ...quiet]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "failed",
        message: expect.stringContaining("waited 30 seconds"),
      },
    });
    expect(slept).toEqual([10, 10, 10]);
  });

  test("a free slot after a quota_exhausted refusal prints the next key, which dispatch accepts", async () => {
    await conn.sql`update ledger.task set state = 'ready', deps = '[]' where task_id = 'task_r'`;
    const refused = await dispatch(
      conn.db,
      noCalls(),
      replay(conn, []).log,
      dispatchInput({ task: "task_r", seat: "rev-1", capacity: 1 }),
    );
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
    const key = derivedOpKey("dispatch", {
      run_id: "run_1",
      task_id: "task_r",
      seat: "rev-1",
      attempt: "2",
    });
    const outcome = await wait([
      ok("check", batch("delivery_1", [done("msg_1")]), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok("worker-list", workers([]), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        nextSteps: [
          `pod dispatch --task task_r --seat rev-1 --generation 1 --op-key ${key}`,
          "usage has no source for claude, codex; pod state shows unknown",
        ],
      },
    });
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_r", "task_r"), ["--task", "task_r"]),
    ]);
    expect(
      await dispatch(
        conn.db,
        orca,
        log,
        dispatchInput({
          task: "task_r",
          seat: "rev-1",
          capacity: 1,
          opKey: key,
        }),
      ),
    ).toMatchObject({ ok: true, opKey: key, result: { dispatch_id: "ctx_r" } });
  });

  test("no next key while no slot is free", async () => {
    await conn.sql`update ledger.task set state = 'ready', deps = '[]' where task_id = 'task_r'`;
    await dispatch(
      conn.db,
      noCalls(),
      replay(conn, []).log,
      dispatchInput({ task: "task_r", seat: "rev-1", capacity: 1 }),
    );
    const outcome = await wait([...quiet, ...quiet, ...quiet, ...quiet]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { nextSteps: ["pod check --wait"] },
    });
  });
});
