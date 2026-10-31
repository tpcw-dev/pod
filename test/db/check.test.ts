import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  checkPass,
  resume,
  type CheckInput,
} from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { candidateSha } from "../../src/core/gate/receipt.ts";
import { postVerdict } from "../../src/core/gate/verdict.ts";
import { runBlocked } from "../../src/core/ledger/run-blocked.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fixtures } from "../orca/temp-fixtures.ts";
import { fakeTracker, trackerStory, type FakeTracker } from "./fake-tracker.ts";
import { gatedRun, headSha } from "./gate-fixture.ts";
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
    const outcome = await checkPass(conn.db, orca, null, log, input(over));
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
    expect(await taskState(conn, "task_b")).toBe("done");
    expect(await taskState(conn, "task_r")).toBe("ready");
    expect((await events(conn, "delivery")).map((row) => row.payload)).toEqual([
      expect.objectContaining({
        message_id: "msg_1",
        outcome: "done",
        delivery_id: "delivery_1",
      }),
    ]);
    expect((await events(conn, "outcome")).map((row) => row.payload)).toEqual([
      {
        task_id: "task_b",
        step_id: "build",
        lineage_id: "run_1:build",
        outcome: "done",
        edge: { to: "review", new_task: false, then: null },
      },
    ]);
  });

  const sha = "0123456789abcdef0123456789abcdef01234567";
  const deliver = (fields: Record<string, unknown>) =>
    pass([
      ok(
        "check",
        batch("delivery_1", [
          message("msg_1", "worker_done", {
            taskId: "task_b",
            dispatchId: "ctx_1",
            outcome: "succeeded",
            ...fields,
          }),
        ]),
        run,
      ),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "succeeded" }]),
        run,
      ),
    ]);

  test("a worker_done with head appends one push event that is the candidate SHA", async () => {
    expect(await candidateSha(conn.db, "run_1")).toBeNull();
    await deliver({ head: sha });
    expect(await events(conn, "push")).toEqual([
      {
        task_id: "task_b",
        dispatch_id: "ctx_1",
        payload: { task_id: "task_b", dispatch_id: "ctx_1", sha },
      },
    ]);
    expect(await candidateSha(conn.db, "run_1")).toBe(sha);
    expect(await events(conn, "pr")).toEqual([]);
    expect(await events(conn, "deploy")).toEqual([]);
  });

  test("a worker_done with pr and deploy appends one event of each", async () => {
    const deploy = {
      environment: "staging",
      deployment_id: "dep-1",
      deployed_revision: "rev-9",
      source_commit: sha,
    };
    await deliver({
      pr: { number: 7, url: "https://x/pr/7", head: sha },
      deploy,
    });
    expect((await events(conn, "pr")).map((row) => row.payload)).toEqual([
      {
        task_id: "task_b",
        dispatch_id: "ctx_1",
        number: 7,
        url: "https://x/pr/7",
        head: sha,
      },
    ]);
    expect((await events(conn, "deploy")).map((row) => row.payload)).toEqual([
      { task_id: "task_b", dispatch_id: "ctx_1", ...deploy },
    ]);
    expect(await events(conn, "push")).toEqual([]);
  });

  test("a malformed head or pr is an ignored line and records no event", async () => {
    const outcome = await deliver({
      head: sha.toUpperCase(),
      pr: { number: "7", url: "https://x/pr/7", head: sha },
    });
    expect(await events(conn, "push")).toEqual([]);
    expect(await events(conn, "pr")).toEqual([]);
    expect(outcome.ok && outcome.result.nextSteps).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ignored head on message msg_1: /),
        expect.stringMatching(/^ignored pr on message msg_1: /),
      ]),
    );
  });

  test("a failed worker_done on an ungated step takes the unknown edge to hold", async () => {
    await pass([
      ok("check", batch("delivery_1", [done("msg_1", "ctx_1", "failed")]), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "failed" }]),
        run,
      ),
    ]);
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      settlement: "failed",
    });
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(await taskState(conn, "task_r")).toBe("pending");
    expect((await events(conn, "hold")).at(-1)?.payload).toEqual({
      reason: "edge",
      outcome: "unknown",
      from: "delivered",
    });
  });

  test("a tracker Canceled holds the Run and its open Tasks once, each hold naming its prior state", async () => {
    const tracker = fakeTracker(
      trackerStory({ status: "Canceled", statusType: "canceled" }),
    );
    const quiet = [
      ok("check", empty(null), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "running" }]),
        run,
      ),
    ];
    for (let i = 0; i < 2; i += 1) {
      const { orca, log } = replay(conn, quiet);
      const outcome = await checkPass(conn.db, orca, tracker, log, input());
      orca.assertDone();
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          nextSteps: expect.arrayContaining([
            "story:S-1 is Canceled in the tracker; the Run is on hold",
          ]),
        },
      });
    }
    expect(tracker.calls).toEqual(["readStory", "readStory"]);
    expect((await events(conn, "cancel")).map((row) => row.payload)).toEqual([
      { reason: "tracker_canceled", status: "Canceled" },
    ]);
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect(
      await conn.sql`select task_id, payload from ledger.event where type = 'hold' order by id`,
    ).toEqual([
      {
        task_id: null,
        payload: { reason: "tracker_canceled", from: "active" },
      },
      {
        task_id: "task_b",
        payload: { reason: "tracker_canceled", from: "dispatched" },
      },
      {
        task_id: "task_r",
        payload: { reason: "tracker_canceled", from: "pending" },
      },
    ]);
    expect((await conn.db.getStory("linear", "S-1"))?.status).toBe("Canceled");
  });

  test("a tracker Canceled leaves a Task already on hold with its earlier hold event", async () => {
    await conn.db.setTaskState("task_b", "hold");
    await conn.db.appendEvent({
      type: "hold",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: "task_b",
      dispatch_id: null,
      op_key: null,
      payload: { reason: "unknown_delivery", from: "dispatched" },
      source: { kind: "command", verb: "check" },
    });
    const tracker = fakeTracker(
      trackerStory({ status: "Canceled", statusType: "canceled" }),
    );
    const { orca, log } = replay(conn, [
      ok("check", empty(null), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "running" }]),
        run,
      ),
    ]);
    expect((await checkPass(conn.db, orca, tracker, log, input())).ok).toBe(
      true,
    );
    orca.assertDone();
    expect(
      await conn.sql`select payload from ledger.event where type = 'hold' and task_id = 'task_b' order by id`,
    ).toEqual([
      { payload: { reason: "unknown_delivery", from: "dispatched" } },
    ]);
    expect(await taskState(conn, "task_b")).toBe("hold");
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
      await checkPass(conn.db, noCalls(), null, log, input({ generation: 2 })),
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

describeDb("pod check and Gate receipts", () => {
  let conn: Connection;
  let tracker: FakeTracker;
  const bypassPath = join(
    mkdtempSync(join(tmpdir(), "pod-check-bypass-")),
    "bypass.jsonl",
  );
  writeFileSync(
    bypassPath,
    `${JSON.stringify({ host: "h1", result: "pass", at: "t-1" })}\n`,
  );
  const principals = { human: { tracker_account: "keeper-1" } };
  const hqaGate = { pr: { keeper: "human", type: "HQA" } };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function quietCheck() {
    const { orca, log } = replay(conn, [
      ok("check", empty(null), run),
      ok("worker-list", workers([]), run),
    ]);
    const outcome = await checkPass(
      conn.db,
      orca,
      tracker,
      log,
      input({ capacity: 2 }),
    );
    orca.assertDone();
    return outcome;
  }

  async function recordKeeper(body: string) {
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: "c-keeper" },
      authorId: "keeper-1",
      body,
      editedAt: null,
    });
    const recorded = await recordHqa(
      conn.db,
      noCalls(),
      tracker,
      receiptLog(conn.db, "local"),
      {
        story: { provider: "linear", external_id: "S-1" },
        generation: 1,
        host: "local",
        hostName: "h1",
        bypassPath,
        command: "pod hqa record story:S-1 --generation 1",
        now: () => new Date(),
      },
    );
    if (!recorded.ok) throw new Error(recorded.refusal.message);
    return recorded.result.receipt_id ?? 0;
  }

  function edit(body: string) {
    const [comment] = tracker.comments;
    if (comment === undefined) throw new Error("no comment to edit");
    tracker.comments[0] = {
      ...comment,
      body,
      editedAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  const syncStates = async () =>
    (
      await conn.sql<
        { sync_state: string }[]
      >`select sync_state from ledger.gate_receipt order by id`
    ).map((row) => row.sync_state);

  const receiptHolds = async () =>
    (await events(conn, "hold")).filter(
      (row) => row.payload["reason"] === "receipt_voided",
    );

  test("a pending verdict receipt is synced once its outbox row is acked", async () => {
    await gatedRun(conn, { gates: { pr: { keeper: "rev-1", type: "AQA" } } });
    tracker = fakeTracker();
    const posted = await postVerdict(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      {
        file: {
          gate: "pr",
          task: "task_r",
          head_sha: headSha,
          reviewer: "rev-1",
          outcome: "PASS",
        },
        generation: 1,
        host: "local",
        command: "pod verdict post v.yaml --generation 1",
        now: () => new Date(),
      },
    );
    expect(posted.ok).toBe(true);
    expect(await syncStates()).toEqual(["pending"]);
    await quietCheck();
    expect(tracker.comments.map((row) => row.body)).toEqual([
      `rev-1: pr PASS\nHead: ${headSha}`,
    ]);
    expect(await syncStates()).toEqual(["synced"]);
  });

  test("an edited keeper comment voids its receipt once and holds the Run, leaving the done Task", async () => {
    await gatedRun(conn, { gates: hqaGate, principals });
    tracker = fakeTracker();
    const receiptId = await recordKeeper("pr PASS");
    expect(await taskState(conn, "task_r")).toBe("done");
    await quietCheck();
    expect(await syncStates()).toEqual(["synced"]);
    edit("pr PASS (edited)");
    const first = await quietCheck();
    expect(first.ok && first.result.nextSteps).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`receipt ${receiptId} on gate pr is voided`),
      ]),
    );
    const reads = tracker.calls.length;
    await quietCheck();
    expect(tracker.calls.slice(reads)).toEqual(["readStory"]);
    expect(await syncStates()).toEqual(["voided"]);
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    expect(await taskState(conn, "task_r")).toBe("done");
    expect(await receiptHolds()).toEqual([
      {
        task_id: null,
        dispatch_id: null,
        payload: {
          reason: "receipt_voided",
          receipt_id: receiptId,
          from: "active",
        },
      },
      {
        task_id: "task_r",
        dispatch_id: null,
        payload: {
          reason: "receipt_voided",
          receipt_id: receiptId,
          moved: false,
        },
      },
    ]);
  });

  test("a voided receipt on a held Task adds no Task event, so resume reads the earlier from", async () => {
    await gatedRun(conn, { gates: hqaGate, principals });
    tracker = fakeTracker();
    await recordKeeper("pr FAIL");
    expect(await taskState(conn, "task_r")).toBe("hold");
    edit("pr FAIL, edited");
    await quietCheck();
    expect(await syncStates()).toEqual(["voided"]);
    expect((await receiptHolds()).map((row) => row.task_id)).toEqual([null]);
    const resumed = await resume(conn.db, {
      run: "run_1",
      task: null,
      generation: 1,
      host: "local",
      now: () => new Date(),
    });
    expect(resumed.ok).toBe(true);
    expect(await taskState(conn, "task_r")).toBe("delivered");
  });

  test("a voided receipt on a delivered Task moves it to hold with its from", async () => {
    await gatedRun(conn, { gates: hqaGate, principals });
    tracker = fakeTracker();
    const receiptId = await recordKeeper("pr PASS");
    await conn.sql`update ledger.task set state = 'delivered' where task_id = 'task_r'`;
    edit("pr PASS, edited");
    await quietCheck();
    expect(await taskState(conn, "task_r")).toBe("hold");
    expect((await receiptHolds()).at(-1)).toEqual({
      task_id: "task_r",
      dispatch_id: null,
      payload: {
        reason: "receipt_voided",
        receipt_id: receiptId,
        from: "delivered",
      },
    });
  });
});
