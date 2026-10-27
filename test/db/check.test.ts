import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, type CheckInput } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { runBlocked } from "../../src/core/ledger/run-blocked.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fixtures } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
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
const ack = (id: string) => ["--run", "run_1", "--ack", id];

function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    run: "run_1",
    generation: 1,
    host: "local",
    capacity: 1,
    leaseSeconds: launchLeaseSeconds,
    now: () => new Date(),
    ...over,
  };
}

const done = (id: string, dispatchId: string, outcome = "succeeded") =>
  message(id, "worker_done", { taskId: "task_b", dispatchId, outcome });

describeDb("pod check", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await dispatched(conn, "ctx_1");
  });
  afterAll(() => conn.close());

  async function pass(
    entries: readonly TempEntry[],
    over: Partial<CheckInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, log, input(over));
    orca.assertDone();
    return outcome;
  }

  test("a matched worker_done settles the Dispatch, moves the Task, and frees the slot", async () => {
    const outcome = await pass([
      ok("check", batch("delivery_1", [done("msg_1", "ctx_1")]), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "succeeded" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        deliveries: [
          { message_id: "msg_1", dispatch_id: "ctx_1", outcome: "done" },
        ],
        acked: ["delivery_1"],
        free_slots: 1,
        stopped: [],
        unknown_workers: [],
      },
    });
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      activity: "settled",
      settlement: "done",
      settled_at: expect.any(Date),
    });
    expect(await taskState(conn, "task_b")).toBe("delivered");
    expect((await events(conn, "delivery")).map((row) => row.payload)).toEqual([
      expect.objectContaining({
        message_id: "msg_1",
        outcome: "done",
        delivery_id: "delivery_1",
      }),
    ]);
  });

  test("a mismatched dispatchId records ignored and moves nothing", async () => {
    const outcome = await pass([
      ok(
        "check",
        batch("delivery_1", [
          done("msg_1", "ctx_other"),
          message("msg_2", "heartbeat", {
            dispatchId: "ctx_other",
            phase: "waiting",
          }),
          message("msg_3", "status", "not json"),
        ]),
        run,
      ),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "ready" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { deliveries: [], ignored: 3 },
    });
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["unknown_dispatch", "unknown_dispatch", "no_dispatch"]);
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      settlement: "open",
      activity: "running",
    });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
  });

  test("a batch read again before its ack records nothing twice", async () => {
    const first = [
      done("msg_1", "ctx_1"),
      message("msg_2", "heartbeat", { dispatchId: "ctx_1" }),
      done("msg_3", "ctx_other"),
    ];
    const failed = await pass([
      ok("check", batch("delivery_1", first), run),
      { verb: "check", argv: ack("delivery_1"), exitCode: 1, stdout: "" },
    ]);
    expect(failed).toMatchObject({ ok: false, refusal: { code: "failed" } });
    const again = await pass([
      ok("check", batch("delivery_1", first), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok("worker-list", workers([]), run),
    ]);
    expect(again).toMatchObject({
      ok: true,
      result: { deliveries: [], ignored: 0, acked: ["delivery_1"] },
    });
    expect(await events(conn, "delivery")).toHaveLength(1);
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["settled_dispatch", "unknown_dispatch"]);
  });

  test("escalation leaves the Dispatch waiting, and an unnamed type holds the Task", async () => {
    await pass([
      ok(
        "check",
        batch("delivery_1", [
          message("msg_1", "escalation", { dispatchId: "ctx_1" }),
        ]),
        run,
      ),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok("worker-list", workers([]), run),
    ]);
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      activity: "waiting",
      settlement: "open",
      settled_at: null,
    });
    expect(await taskState(conn, "task_b")).toBe("delivered");
    await pass([
      ok(
        "check",
        batch("delivery_3", [
          message("msg_3", "novel", { dispatchId: "ctx_1" }),
        ]),
        run,
      ),
      ok("check", empty("delivery_3"), ack("delivery_3")),
      ok("worker-list", workers([]), run),
    ]);
    expect(await taskState(conn, "task_b")).toBe("delivered");
    await conn.sql`update ledger.task set state = 'dispatched' where task_id = 'task_b'`;
    await pass([
      ok(
        "check",
        batch("delivery_2", [
          message("msg_2", "novel", { dispatchId: "ctx_1" }),
        ]),
        run,
      ),
      ok("check", empty("delivery_2"), ack("delivery_2")),
      ok("worker-list", workers([]), run),
    ]);
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(
      (await events(conn, "delivery")).map((row) => row.payload["outcome"]),
    ).toEqual(["waiting", "unknown", "unknown"]);
    expect((await events(conn, "hold")).at(-1)?.payload).toMatchObject({
      reason: "unknown_delivery",
      message_id: "msg_2",
      from: "dispatched",
    });
  });

  test("a stopped worker blocks its Task only, and its late worker_done is ignored", async () => {
    const outcome = await pass([
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "stopped" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { stopped: ["ctx_1"], free_slots: 1 },
    });
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      activity: "settled",
      settlement: "stopped",
    });
    expect(await taskState(conn, "task_b")).toBe("blocked");
    expect((await events(conn, "stop")).map((row) => row.dispatch_id)).toEqual([
      "ctx_1",
    ]);
    expect(await runBlocked(conn.db, "run_1")).toBeNull();
    await pass([
      ok("check", batch("delivery_1", [done("msg_1", "ctx_1")]), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "stopped" }]),
        run,
      ),
    ]);
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["settled_dispatch"]);
    expect(await events(conn, "stop")).toHaveLength(1);
    expect(await taskState(conn, "task_b")).toBe("blocked");
  });

  test("an unknown worker records unknown_launch once and holds the Run and its open Tasks", async () => {
    const list = workers([
      { dispatchId: "ctx_1", workerState: "ready" },
      { dispatchId: "ctx_rogue", taskId: "task_r", workerState: "ready" },
    ]);
    const outcome = await pass([
      ok("check", empty(), run),
      ok("worker-list", list, run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { unknown_workers: ["ctx_rogue"] },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(await taskState(conn, "task_r")).toBe("pending");
    expect(
      (await events(conn, "hold")).map((row) => [
        row.task_id,
        row.payload["from"],
      ]),
    ).toEqual([
      [null, "active"],
      ["task_b", "dispatched"],
    ]);
    await pass([ok("check", empty(), run), ok("worker-list", list, run)]);
    expect(await events(conn, "unknown_launch")).toHaveLength(1);
  });

  test("worker-list follows nextCursor across pages", async () => {
    const outcome = await pass([
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers(
          [{ dispatchId: "ctx_x", taskId: "task_r", workerState: "ready" }],
          "c2",
        ),
        run,
      ),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "stopped" }]),
        ["--run", "run_1", "--cursor", "c2"],
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { stopped: ["ctx_1"], unknown_workers: ["ctx_x"] },
    });
  });

  test("a stale generation is refused before any Orca call", async () => {
    const log = receiptLog(conn.db, "local");
    expect(
      await checkPass(conn.db, noCalls(), log, input({ generation: 2 })),
    ).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
  });

  test("a check Orca refuses is failed and names the error code", async () => {
    const outcome = await pass([
      {
        verb: "check",
        argv: run,
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "consumer_fenced", message: "no" },
        }),
      },
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "failed",
        nextSteps: expect.arrayContaining(["Orca error consumer_fenced"]),
      },
    });
  });

  test("the CLI takes --run, rejects mixed forms, and refuses a resume of a Run not in hold", () => {
    const done = runCli(["check", "--run", "run_1", "--generation", "1"], {
      POD_ORCA_FIXTURES: fixtures([
        ok("check", empty(), run),
        ok("worker-list", workers([]), run),
      ]),
    });
    expect(done.status).toBe(0);
    expect(done.json).toMatchObject({
      ok: true,
      result: { run_id: "run_1" },
      meta: { ownerGeneration: 1, orca: "1.4.211" },
    });
    for (const args of [
      ["check", "--generation", "1"],
      ["check", "--run", "run_1", "--task", "task_b", "--generation", "1"],
      ["check", "--run", "run_1", "--interval", "5", "--generation", "1"],
      ["check", "--resume", "--generation", "1"],
      [
        "check",
        "--resume",
        "--run",
        "run_1",
        "--task",
        "task_b",
        "--generation",
        "1",
      ],
      ["check", "--resume", "--run", "run_1", "--wait", "--generation", "1"],
    ])
      expect(runCli(args).status, args.join(" ")).toBe(2);
    const resumed = runCli([
      "check",
      "--resume",
      "--run",
      "run_1",
      "--generation",
      "1",
    ]);
    expect(resumed.status).toBe(3);
    expect(resumed.json.error).toMatchObject({
      code: "task_not_ready",
      nextSteps: ["Run state active"],
    });
  });

  test("the CLI prints each resumed row's to", async () => {
    await conn.sql`update ledger.task set state = 'hold' where task_id = 'task_b'`;
    const resumed = runCli([
      "check",
      "--resume",
      "--task",
      "task_b",
      "--generation",
      "1",
    ]);
    expect(resumed.status).toBe(0);
    expect(resumed.json).toMatchObject({
      ok: true,
      result: { resumed: [{ kind: "task", id: "task_b", to: "ready" }] },
    });
  });
});
