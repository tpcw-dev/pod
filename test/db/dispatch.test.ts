import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  dispatch,
  type DispatchInput,
} from "../../src/core/dispatch/dispatch.ts";
import { reconcileLaunches } from "../../src/core/check/reconcile.ts";
import { launchIntents } from "../../src/core/dispatch/quota.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate } from "../../src/core/run/create.ts";
import {
  fixtures,
  lost,
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { residentSeat } from "./resident-fixture.ts";
import { seedConfig, seedHost } from "./seed.ts";

const requestId = "44444444-4444-4444-8444-444444444444";

const devArgv = [
  "--task",
  "task_b",
  "--run",
  "run_1",
  "--agent",
  "claude",
  "--model",
  "m-1",
  "--effort",
  "low",
  "--worktree",
  "current",
];

function started(dispatchId: string, model: string | null): unknown {
  return {
    dispatchId,
    state: "ready",
    taskId: "task_b",
    terminalHandle: `term_${dispatchId}`,
    launch:
      model === null ? null : { requested: { model }, effective: { model } },
  };
}

describeDb("pod dispatch", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });

  beforeEach(async () => {
    await clearDb(conn);
    await seedConfig(conn.db);
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({
      dir: fixtures([
        ok("run-create", { run: { id: "run_1" } }),
        ok("task-create", { task: { id: "task_b", status: "ready" } }),
        ok("task-create", { task: { id: "task_r", status: "pending" } }),
      ]),
      sink: log.sink,
    });
    const created = await runCreate(conn.db, orca, null, log, {
      story: "S-1",
      process: { name: "impl", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "session-1",
      host: "local",
      provider: "linear",
      command: "pod run create story:S-1",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
  });
  afterAll(() => conn.close());

  function input(over: Partial<DispatchInput> = {}): DispatchInput {
    return {
      task: "task_b",
      seat: "dev-1",
      generation: 1,
      opKey: null,
      host: "local",
      capacity: 2,
      command: (opKey) =>
        `pod dispatch --task task_b --seat dev-1 --generation 1 --op-key ${opKey}`,
      now: () => new Date(),
      ...over,
    };
  }

  function replay(entries: readonly TempEntry[]) {
    const log = receiptLog(conn.db, "local");
    return {
      orca: makeReplayOrca({ dir: fixtures(entries), sink: log.sink }),
      log,
    };
  }

  function run(orca: OrcaPort, over: Partial<DispatchInput> = {}) {
    return dispatch(conn.db, orca, receiptLog(conn.db, "local"), input(over));
  }

  async function operation(opKey: string) {
    const [row] = await conn.sql<{ status: string; intent: string }[]>`
      select status, intent from ledger.operation where op_key = ${opKey}`;
    return row;
  }

  async function expectRefused(code: string, over: Partial<DispatchInput>) {
    const opKey = `k-${code}-${Math.random()}`;
    const outcome = await run(noCalls(), { ...over, opKey });
    expect(outcome).toMatchObject({ ok: false, refusal: { code } });
    expect(await operation(opKey)).toEqual({
      status: "refused",
      intent: "dispatch",
    });
    const again = await run(noCalls(), { ...over, opKey });
    expect(again).toEqual(outcome);
  }

  test("dispatch records the manifest, the Dispatch, and the start event, and starts the worker", async () => {
    const { orca, log } = replay([
      ok("worker-start", started("ctx_1", "m-1"), devArgv),
    ]);
    const outcome = await dispatch(conn.db, orca, log, input());
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      opKey: expect.stringMatching(/^dispatch:/),
      result: {
        dispatch_id: "ctx_1",
        task_id: "task_b",
        run_id: "run_1",
        seat: "dev-1",
        model_attribution: "receipt",
        terminal_handle: "term_ctx_1",
        owner_generation: 1,
      },
    });
    if (!outcome.ok) return;
    const row = await conn.db.getDispatch("ctx_1");
    expect(row).toMatchObject({
      manifest_id: outcome.result.manifest_id,
      activity: "running",
      settlement: "open",
      requested_launch: { model: "m-1" },
      effective_launch: { model: "m-1" },
      op_key: outcome.opKey,
      prompt_bytes: null,
    });
    expect(
      await conn.db.getManifest(outcome.result.manifest_id),
    ).not.toBeNull();
    expect((await conn.db.getTask("task_b"))?.state).toBe("dispatched");
    expect(await operation(outcome.opKey)).toEqual({
      status: "done",
      intent: "dispatch",
    });
    const kinds = await conn.sql<
      { type: string; dispatch_id: string | null }[]
    >`
      select type, dispatch_id from ledger.event where op_key = ${outcome.opKey} order by id`;
    expect(kinds).toEqual([
      { type: "receipt", dispatch_id: null },
      { type: "start", dispatch_id: "ctx_1" },
    ]);
    expect(await conn.db.launchReservations(launchIntents)).toEqual([]);
    expect(await run(noCalls())).toEqual(outcome);
  });

  test("a receipt that names no model records model_attribution unknown", async () => {
    const { orca, log } = replay([ok("worker-start", started("ctx_2", null))]);
    const outcome = await dispatch(conn.db, orca, log, input());
    expect(outcome).toMatchObject({
      ok: true,
      result: { model_attribution: "unknown" },
    });
    expect((await conn.db.getDispatch("ctx_2"))?.requested_launch).toEqual({
      agent: "claude",
      model: "m-1",
      effort: "low",
      worktree: "current",
    });
  });

  test("the Dispatch row records the receipt's worktree as an id selector", async () => {
    const { orca, log } = replay([
      ok("worker-start", {
        ...(started("ctx_3", "m-1") as object),
        effects: [
          { kind: "terminal", id: "term_1" },
          { kind: "worktree", action: "reused", id: "repo-1::/w/one" },
        ],
      }),
    ]);
    const outcome = await dispatch(conn.db, orca, log, input());
    expect(outcome.ok).toBe(true);
    expect((await conn.db.getDispatch("ctx_3"))?.requested_launch).toEqual({
      model: "m-1",
      worktree: "id:repo-1::/w/one",
    });
    const [op] = await conn.sql<{ result_ref: { launch: unknown } }[]>`
      select result_ref from ledger.operation where intent = 'dispatch'`;
    expect(op?.result_ref.launch).toEqual({
      agent: "claude",
      model: "m-1",
      effort: "low",
      worktree: "current",
    });
  });

  test("a generation other than the Run's is owner_generation_stale", async () => {
    await expectRefused("owner_generation_stale", { generation: 2 });
    await conn.sql`update ledger.run set owner_generation = 3`;
    await expectRefused("owner_generation_stale", { generation: 2 });
  });

  test("an op key of another intent or request is duplicate_op", async () => {
    await conn.db.insertOperation({
      op_key: "taken",
      intent: "config_apply",
      owner_generation: 0,
      at: new Date(),
    });
    expect(await run(noCalls(), { opKey: "taken" })).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
    await expectRefused("role_unfilled", { seat: "nope" });
    const [row] = await conn.sql<{ op_key: string }[]>`
      select op_key from ledger.operation where status = 'refused'`;
    expect(
      await run(noCalls(), { opKey: row?.op_key ?? "", seat: "dev-1" }),
    ).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
  });

  test("a drain in force is drained, and an ended drain is not", async () => {
    const drain = (payload: { ended: boolean; op_key: string }) =>
      conn.db.appendEvent({
        type: "drain",
        ts: new Date(),
        host: "local",
        run_id: "run_1",
        task_id: null,
        dispatch_id: null,
        op_key: null,
        payload,
        source: { kind: "command", verb: "drain" },
      });
    await drain({ ended: false, op_key: "k-drain" });
    await expectRefused("drained", {});
    await drain({ ended: true, op_key: "k-end" });
    await expectRefused("role_unfilled", { seat: "nope" });
  });

  test("a Task, dependency, or Run that is not ready is task_not_ready", async () => {
    await expectRefused("task_not_ready", { task: "task_r", seat: "rev-1" });
    await conn.sql`update ledger.task set state = 'ready' where task_id = 'task_r'`;
    const outcome = await run(noCalls(), {
      task: "task_r",
      seat: "rev-1",
      opKey: "dep",
    });
    expect(outcome).toMatchObject({
      refusal: {
        code: "task_not_ready",
        nextSteps: expect.arrayContaining(["dependency task_b is ready"]),
      },
    });
    await conn.sql`update ledger.run set state = 'hold'`;
    await expectRefused("task_not_ready", {});
    await conn.sql`update ledger.run set state = 'active'`;
    await conn.db.appendEvent({
      type: "stop",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: {},
      source: { kind: "command", verb: "check" },
    });
    await expectRefused("task_not_ready", {});
  });

  test("an open launch for the same Task under another key is task_not_ready with no Orca call", async () => {
    await conn.db.insertOperation({
      op_key: "in-flight",
      intent: "dispatch",
      owner_generation: 1,
      at: new Date(),
      result_ref: {
        request: { task_id: "task_b", seat: "dev-1", host: "local" },
      },
    });
    const outcome = await run(noCalls(), { seat: "both-1", opKey: "second" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        nextSteps: expect.arrayContaining([
          "launch in-flight (dispatch) is pending for Task task_b",
        ]),
      },
    });
    await conn.db.moveOperation(
      "in-flight",
      "unknown",
      { request: { task_id: "task_b", seat: "dev-1", host: "local" } },
      new Date(),
    );
    await expectRefused("task_not_ready", {});
  });

  test("no free slot is quota_exhausted, counting reservations and running Dispatches", async () => {
    await conn.db.insertOperation({
      op_key: "held",
      intent: "retry",
      owner_generation: 1,
      at: new Date(),
    });
    await conn.db.moveOperation("held", "unknown", null, new Date());
    await expectRefused("quota_exhausted", { capacity: 1 });
    await conn.db.moveOperation("held", "refused", null, new Date());
    await conn.db.insertOperation({
      op_key: "far",
      intent: "dispatch",
      owner_generation: 1,
      at: new Date(),
      result_ref: {
        request: { task_id: "other", seat: "x", host: "elsewhere" },
      },
    });
    await expectRefused("role_unfilled", { capacity: 1, seat: "nope" });
  });

  test("a Seat outside the crew, without the role, or on another host is role_unfilled", async () => {
    await expectRefused("role_unfilled", { seat: "nope" });
    await expectRefused("role_unfilled", { seat: "rev-1" });
    await expectRefused("role_unfilled", { seat: "far-1" });
  });

  test("a reviewer Task on a Seat holding a developer Dispatch is reviewer_not_independent", async () => {
    const { orca, log } = replay([ok("worker-start", started("ctx_3", null))]);
    const first = await dispatch(conn.db, orca, log, input({ seat: "both-1" }));
    expect(first.ok).toBe(true);
    await conn.sql`update ledger.task set state = 'passed' where task_id = 'task_b'`;
    await conn.sql`update ledger.task set state = 'ready' where task_id = 'task_r'`;
    await expectRefused("reviewer_not_independent", {
      task: "task_r",
      seat: "both-1",
    });
  });

  test("outcome_unknown holds the Task and the slot, and a rerun asks request-show", async () => {
    const { orca, log } = replay([unknownReply("worker-start", requestId)]);
    const outcome = await dispatch(conn.db, orca, log, input({ opKey: "u-1" }));
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        nextSteps: [
          "pod dispatch --task task_b --seat dev-1 --generation 1 --op-key u-1",
          "pod check",
        ],
      },
    });
    expect((await conn.db.getTask("task_b"))?.state).toBe("hold");
    expect(await conn.db.launchReservations(launchIntents)).toMatchObject([
      { op_key: "u-1", intent: "dispatch", status: "unknown" },
    ]);
    const holds =
      await conn.sql`select payload from ledger.event where type = 'hold' and task_id = 'task_b'`;
    expect(holds.map((row) => row["payload"])).toMatchObject([
      { reason: "launch_unknown", from: "ready" },
    ]);
    const show = replay([
      ok("request-show", { requestId, state: "completed" }, [
        "--request",
        requestId,
      ]),
    ]);
    const again = await dispatch(
      conn.db,
      show.orca,
      show.log,
      input({ opKey: "u-1" }),
    );
    show.orca.assertDone();
    expect(again).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        message: expect.stringContaining("completed"),
      },
    });
  });

  test("a failed worker-start leaves the Task ready and exits failed", async () => {
    const { orca, log } = replay([
      {
        verb: "worker-start",
        exitCode: 1,
        result: { state: "failed", lastError: "no agent" },
      },
    ]);
    const outcome = await dispatch(conn.db, orca, log, input({ opKey: "f-1" }));
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "failed" } });
    expect((await conn.db.getTask("task_b"))?.state).toBe("ready");
    expect(await operation("f-1")).toEqual({
      status: "done",
      intent: "dispatch",
    });
  });

  async function residentDecider() {
    await residentSeat(conn, "ctx_dec", "decider", "running", {
      seat: "both-1",
    });
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_dec",
      coordinator: "term_ctx_dec",
    });
  }

  async function activity(dispatchId: string) {
    return (await conn.db.getDispatch(dispatchId))?.activity;
  }

  async function resultRef(opKey: string) {
    return (await conn.db.getOperation(opKey))?.result_ref;
  }

  test("at capacity 1 the coordinator's slot passes to the worker in the reservation transaction, before worker-start", async () => {
    await residentDecider();
    const seen: (string | undefined)[] = [];
    const { orca, log } = replay([ok("worker-start", started("ctx_w", null))]);
    const watched: OrcaPort = {
      ...orca,
      workerStart: async (req) => {
        seen.push(await activity("ctx_dec"));
        seen.push((await conn.db.launchReservations(launchIntents))[0]?.status);
        return orca.workerStart(req);
      },
    };
    const outcome = await dispatch(
      conn.db,
      watched,
      log,
      input({ capacity: 1, opKey: "h-1" }),
    );
    orca.assertDone();
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(["waiting", "pending"]);
    expect(await activity("ctx_dec")).toBe("waiting");
    expect(await resultRef("h-1")).toMatchObject({
      coordinator_waiting: "ctx_dec",
    });
  });

  test("a failed worker-start returns the coordinator's slot", async () => {
    await residentDecider();
    const { orca, log } = replay([
      {
        verb: "worker-start",
        exitCode: 1,
        result: { state: "failed", lastError: "no agent" },
      },
    ]);
    const outcome = await dispatch(
      conn.db,
      orca,
      log,
      input({ capacity: 1, opKey: "h-2" }),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "failed" } });
    expect(await activity("ctx_dec")).toBe("running");
  });

  test("a reservation released by reconcile returns the coordinator's slot", async () => {
    await residentDecider();
    const { orca, log } = replay([lost("worker-start")]);
    await dispatch(conn.db, orca, log, input({ capacity: 1, opKey: "h-3" }));
    expect(await activity("ctx_dec")).toBe("waiting");
    const reconciled = await reconcileLaunches(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      {
        run: (await conn.db.getRun("run_1"))!,
        generation: 1,
        leaseSeconds: 0,
        now: () => new Date(Date.now() + 1000),
        workers: () => Promise.resolve([]),
      },
    );
    expect(reconciled.reconciled).toMatchObject([{ op_key: "h-3" }]);
    expect(await activity("ctx_dec")).toBe("running");
  });

  test("a refused dispatch leaves the coordinator running", async () => {
    await residentDecider();
    await expectRefused("role_unfilled", { capacity: 1, seat: "nope" });
    expect(await activity("ctx_dec")).toBe("running");
  });

  test("a dispatch to a host other than the Run's host does not yield the coordinator's slot", async () => {
    await residentDecider();
    const { orca, log } = replay([
      ok("worker-start", started("ctx_far", null)),
    ]);
    const outcome = await dispatch(
      conn.db,
      orca,
      log,
      input({ capacity: 1, host: "elsewhere", seat: "far-1", opKey: "h-5" }),
    );
    expect(outcome.ok).toBe(true);
    expect(await activity("ctx_dec")).toBe("running");
    expect(await resultRef("h-5")).not.toHaveProperty("coordinator_waiting");
  });

  test("with no coordinator Dispatch nothing yields and no coordinator_waiting is recorded", async () => {
    const { orca, log } = replay([ok("worker-start", started("ctx_w", null))]);
    const outcome = await dispatch(conn.db, orca, log, input({ opKey: "h-6" }));
    expect(outcome.ok).toBe(true);
    expect(await resultRef("h-6")).not.toHaveProperty("coordinator_waiting");
  });

  test("the CLI prints the Dispatch with the owner generation in meta", async () => {
    await seedHost(conn.db);
    const result = runCli(
      ["dispatch", "--task", "task_b", "--seat", "dev-1", "--generation", "1"],
      {
        POD_ORCA_FIXTURES: fixtures([
          ok("worker-start", started("ctx_9", "m-1"), devArgv),
        ]),
      },
    );
    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      result: { dispatch_id: "ctx_9" },
      meta: { ownerGeneration: 1, opKey: expect.stringMatching(/^dispatch:/) },
    });
    const stale = runCli(
      ["dispatch", "--task", "task_b", "--seat", "dev-1", "--generation", "2"],
      {
        POD_ORCA_FIXTURES: fixtures([
          ok("worker-start", started("ctx_9", "m-1")),
        ]),
      },
    );
    expect(stale.status).toBe(3);
    expect(stale.json.error?.code).toBe("owner_generation_stale");
  });
});
