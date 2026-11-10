import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { events } from "../db/run-fixture.ts";

const dir = "test/replay/follow-up-launch";
const orcaDir = "fixtures/orca/follow-up-launch";
const host = "local";
const parent = "ctx_85c7c8a811f8";
const followUp = "ctx_70c80bb55c02";

describeDb("follow-up-launch", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `${dir}/${kind}.yaml`,
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

  test("a same-terminal follow-up is recorded, stopped, and ignored, and the Run is not held", async () => {
    const log = receiptLog(conn.db, host);
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir: orcaDir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const created = await runCreate(conn.db, orca, null, log, {
      story: "TRK-1",
      process: { name: "follow-up-launch", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "operator",
      host,
      provider: "linear",
      command: "pod run create story:TRK-1",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const task = created.result.tasks[0]?.task_id ?? "";
    const started = await dispatch(conn.db, orca, log, {
      task,
      seat: "integrator",
      generation: 1,
      opKey: null,
      host,
      capacity: 1,
      command: (opKey) => `pod dispatch --op-key ${opKey}`,
      now: () => new Date(),
    });
    if (!started.ok) throw new Error(started.refusal.message);
    expect(started.result.dispatch_id).toBe(parent);

    const check = async () => {
      const outcome = await checkPass(conn.db, orca, null, log, {
        run: run_id,
        generation: 1,
        host,
        capacity: 1,
        leaseSeconds: launchLeaseSeconds,
        now: () => new Date(),
      });
      if (!outcome.ok) throw new Error(outcome.refusal.message);
      return outcome.result;
    };

    const first = await check();
    expect(first).toMatchObject({
      deliveries: [],
      ignored: 1,
      unknown_workers: [],
    });
    expect(first.nextSteps).toContain(
      `follow-up ${followUp} of ${parent} stopped; resend to an open Dispatch if the message still matters`,
    );
    expect(
      (await events(conn, "ignored")).map((row) => [
        row.dispatch_id,
        row.payload["message_id"],
        row.payload["type"],
        row.payload["reason"],
        row.payload["follow_up_of"],
      ]),
    ).toEqual([
      [null, "msg_follow_up_done", "worker_done", "follow_up", parent],
    ]);
    expect(
      (await events(conn, "unknown_launch")).map((row) => [
        row.dispatch_id,
        row.payload["follow_up_of"],
      ]),
    ).toEqual([[followUp, parent]]);
    expect(
      (await events(conn, "stop")).map((row) => [
        row.dispatch_id,
        row.payload["outcome"],
        row.payload["follow_up_of"],
      ]),
    ).toEqual([[followUp, "stopped", parent]]);
    expect(await events(conn, "hold")).toEqual([]);
    expect((await conn.db.getRun(run_id))?.state).toBe("active");
    expect((await conn.db.getTask(task))?.state).toBe("dispatched");
    expect((await conn.db.getDispatch(parent))?.settlement).toBe("open");

    const second = await check();
    expect(second.deliveries).toEqual([
      { message_id: expect.any(String), dispatch_id: parent, outcome: "done" },
    ]);
    expect(await events(conn, "stop")).toHaveLength(1);
    expect(
      (await events(conn, "delivery")).map((row) => row.dispatch_id),
    ).toEqual([parent]);
    expect((await conn.db.getRun(run_id))?.state).toBe("active");
    expect((await conn.db.getTask(task))?.state).not.toBe("hold");

    orca.assertDone();
    expect(verbs).toEqual([
      "run-create",
      "task-create",
      "worker-start",
      "check",
      "check",
      "worker-list",
      "worker-stop",
      "check",
      "check",
      "worker-list",
    ]);
  });
});
