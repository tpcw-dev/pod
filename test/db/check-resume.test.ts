import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  checkPass,
  resume,
  type ResumeInput,
} from "../../src/core/check/check.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  batch,
  dispatched,
  empty,
  events,
  freshRun,
  message,
  replay,
  taskState,
  workers,
} from "./run-fixture.ts";

const run = ["--run", "run_1"];
const live = { dispatchId: "ctx_1", workerState: "running" };
const rogue = {
  dispatchId: "ctx_rogue",
  taskId: "task_r",
  workerState: "ready",
};

function input(over: Partial<ResumeInput>): ResumeInput {
  return {
    run: null,
    task: null,
    generation: 1,
    host: "local",
    now: () => new Date(),
    ...over,
  };
}

describeDb("pod check --resume", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  async function pass(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
    });
    orca.assertDone();
    expect(outcome.ok).toBe(true);
  }

  async function holdLiveWorker() {
    await dispatched(conn, "ctx_1");
    await pass([
      ok("check", empty(), run),
      ok("worker-list", workers([live, rogue]), run),
    ]);
    expect(await taskState(conn, "task_b")).toBe("hold");
  }

  async function dispatchRow() {
    return conn.db.getDispatch("ctx_1");
  }

  test("the Task form moves one held Task to ready with a resume event", async () => {
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(await resume(conn.db, input({ task: "task_b" }))).toEqual({
      ok: true,
      result: {
        run_id: "run_1",
        resumed: [{ kind: "task", id: "task_b", to: "ready" }],
      },
    });
    expect(await taskState(conn, "task_b")).toBe("ready");
    expect(await taskState(conn, "task_r")).toBe("hold");
    expect((await events(conn, "resume")).map((row) => row.task_id)).toEqual([
      "task_b",
    ]);
  });

  test("the Run form makes the Run active and every held Task ready, one event per row", async () => {
    await conn.sql`update ledger.run set state = 'hold'`;
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(await resume(conn.db, input({ run: "run_1" }))).toMatchObject({
      ok: true,
      result: {
        resumed: [
          { kind: "run", id: "run_1" },
          { kind: "task", id: "task_b" },
          { kind: "task", id: "task_r" },
        ],
      },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("active");
    expect(await taskState(conn, "task_r")).toBe("ready");
    expect((await events(conn, "resume")).map((row) => row.task_id)).toEqual([
      null,
      "task_b",
      "task_r",
    ]);
  });

  test("a row not in hold is task_not_ready naming its state, and nothing moves", async () => {
    expect(await resume(conn.db, input({ task: "task_b" }))).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", nextSteps: ["Task state ready"] },
    });
    expect(await resume(conn.db, input({ run: "run_1" }))).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", nextSteps: ["Run state active"] },
    });
    expect(await events(conn, "resume")).toEqual([]);
  });

  test("a stale generation is owner_generation_stale", async () => {
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(
      await resume(conn.db, input({ task: "task_b", generation: 2 })),
    ).toMatchObject({ ok: false, refusal: { code: "owner_generation_stale" } });
    expect(await taskState(conn, "task_b")).toBe("hold");
  });

  test("returns a Task held while its worker runs to dispatched", async () => {
    await conn.sql`update ledger.task set state = 'ready' where task_id = 'task_r'`;
    await holdLiveWorker();
    expect(await resume(conn.db, input({ run: "run_1" }))).toEqual({
      ok: true,
      result: {
        run_id: "run_1",
        resumed: [
          { kind: "run", id: "run_1", to: "active" },
          { kind: "task", id: "task_b", to: "dispatched" },
          { kind: "task", id: "task_r", to: "ready" },
        ],
      },
    });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
    expect((await dispatchRow())?.settlement).toBe("open");
    expect(
      (await events(conn, "resume")).map((row) => [row.task_id, row.payload]),
    ).toEqual([
      [null, { reason: "operator", to: "active" }],
      ["task_b", { reason: "operator", to: "dispatched" }],
      ["task_r", { reason: "operator", to: "ready" }],
    ]);
  });

  test("a worker stopped during the hold resumes to blocked", async () => {
    await holdLiveWorker();
    await pass([
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "stopped" }, rogue]),
        run,
      ),
    ]);
    expect((await dispatchRow())?.settlement).toBe("stopped");
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(await resume(conn.db, input({ task: "task_b" }))).toMatchObject({
      ok: true,
      result: { resumed: [{ kind: "task", id: "task_b", to: "blocked" }] },
    });
    expect(await taskState(conn, "task_b")).toBe("blocked");
  });

  test("a worker that finished during the hold resumes to delivered", async () => {
    await holdLiveWorker();
    await pass([
      ok(
        "check",
        batch("delivery_1", [
          message("msg_1", "worker_done", {
            taskId: "task_b",
            dispatchId: "ctx_1",
            outcome: "succeeded",
          }),
        ]),
        run,
      ),
      ok("check", empty("delivery_1"), [
        "--run",
        "run_1",
        "--ack",
        "delivery_1",
      ]),
      ok("worker-list", workers([rogue]), run),
    ]);
    expect((await dispatchRow())?.settlement).toBe("done");
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(await resume(conn.db, input({ task: "task_b" }))).toMatchObject({
      ok: true,
      result: { resumed: [{ kind: "task", id: "task_b", to: "delivered" }] },
    });
    expect(await taskState(conn, "task_b")).toBe("delivered");
  });

  test("a hold event with no from resumes to ready", async () => {
    await dispatched(conn, "ctx_1");
    await conn.sql`update ledger.task set state = 'hold' where task_id = 'task_b'`;
    await conn.db.appendEvent({
      type: "hold",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: "task_b",
      dispatch_id: null,
      op_key: null,
      payload: { reason: "unknown_launch" },
      source: { kind: "command", verb: "check" },
    });
    expect(await resume(conn.db, input({ task: "task_b" }))).toMatchObject({
      ok: true,
      result: { resumed: [{ kind: "task", id: "task_b", to: "ready" }] },
    });
    expect(await taskState(conn, "task_b")).toBe("ready");
  });
});
