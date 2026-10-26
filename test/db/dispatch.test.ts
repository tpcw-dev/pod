import { afterAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch, type DispatchInput } from "../../src/core/dispatch/dispatch.ts";
import { launchIntents } from "../../src/core/dispatch/quota.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate } from "../../src/core/run/create.ts";
import {
  fixtures,
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { seedConfig } from "./seed.ts";

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
    launch: model === null ? null : { requested: { model }, effective: { model } },
  };
}

describeDb("pod dispatch", () => {
  let conn: Connection;

  beforeEach(async () => {
    await conn?.close();
    await resetDb();
    conn = openDb();
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
    const created = await runCreate(conn.db, orca, log, {
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
      command: (opKey) => `pod dispatch --task task_b --seat dev-1 --generation 1 --op-key ${opKey}`,
      now: () => new Date(),
      ...over,
    };
  }

  function replay(entries: readonly TempEntry[]) {
    const log = receiptLog(conn.db, "local");
    return { orca: makeReplayOrca({ dir: fixtures(entries), sink: log.sink }), log };
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
    expect(await operation(opKey)).toEqual({ status: "refused", intent: "dispatch" });
    const again = await run(noCalls(), { ...over, opKey });
    expect(again).toEqual(outcome);
  }

  test("dispatch records the manifest, the Dispatch, and the start event, and starts the worker", async () => {
    const { orca, log } = replay([ok("worker-start", started("ctx_1", "m-1"), devArgv)]);
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
    });
    expect(await conn.db.getManifest(outcome.result.manifest_id)).not.toBeNull();
    expect((await conn.db.getTask("task_b"))?.state).toBe("dispatched");
    expect(await operation(outcome.opKey)).toEqual({ status: "done", intent: "dispatch" });
    const kinds = await conn.sql<{ type: string; dispatch_id: string | null }[]>`
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
    expect(outcome).toMatchObject({ ok: true, result: { model_attribution: "unknown" } });
    expect((await conn.db.getDispatch("ctx_2"))?.requested_launch).toEqual({
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
    expect(await run(noCalls(), { opKey: row?.op_key ?? "", seat: "dev-1" })).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
  });

  test("a drain in force is drained, and an ended drain is not", async () => {
    const drain = (payload: Record<string, boolean>) =>
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
    await drain({});
    await expectRefused("drained", {});
    await drain({ ended: true });
    await expectRefused("role_unfilled", { seat: "nope" });
  });

  test("a Task, dependency, or Run that is not ready is task_not_ready", async () => {
    await expectRefused("task_not_ready", { task: "task_r", seat: "rev-1" });
    await conn.sql`update ledger.task set state = 'ready' where task_id = 'task_r'`;
    const outcome = await run(noCalls(), { task: "task_r", seat: "rev-1", opKey: "dep" });
    expect(outcome).toMatchObject({
      refusal: { code: "task_not_ready", nextSteps: expect.arrayContaining(["dependency task_b is ready"]) },
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

  test("no free slot is quota_exhausted, counting reservations and running Dispatches", async () => {
    await conn.db.insertOperation({
      op_key: "held",
      intent: "retry",
      owner_generation: 1,
      at: new Date(),
    });
    await conn.db.moveOperation("held", "unknown", null, new Date());
    await expectRefused("quota_exhausted", { capacity: 1 });
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
    await expectRefused("reviewer_not_independent", { task: "task_r", seat: "both-1" });
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
    expect(await conn.db.launchReservations(launchIntents)).toEqual([
      { op_key: "u-1", intent: "dispatch", status: "unknown" },
    ]);
    const holds = await conn.sql`select 1 from ledger.event where type = 'hold' and task_id = 'task_b'`;
    expect(holds.length).toBe(1);
    const show = replay([ok("request-show", { requestId, state: "completed" }, ["--request", requestId])]);
    const again = await dispatch(conn.db, show.orca, show.log, input({ opKey: "u-1" }));
    show.orca.assertDone();
    expect(again).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown", message: expect.stringContaining("completed") },
    });
  });

  test("a failed worker-start leaves the Task ready and exits failed", async () => {
    const { orca, log } = replay([
      { verb: "worker-start", exitCode: 1, result: { state: "failed", lastError: "no agent" } },
    ]);
    const outcome = await dispatch(conn.db, orca, log, input({ opKey: "f-1" }));
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "failed" } });
    expect((await conn.db.getTask("task_b"))?.state).toBe("ready");
    expect(await operation("f-1")).toEqual({ status: "done", intent: "dispatch" });
  });

  test("the CLI prints the Dispatch with the owner generation in meta", () => {
    const result = runCli(
      ["dispatch", "--task", "task_b", "--seat", "dev-1", "--generation", "1"],
      { POD_ORCA_FIXTURES: fixtures([ok("worker-start", started("ctx_9", "m-1"), devArgv)]) },
    );
    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      result: { dispatch_id: "ctx_9" },
      meta: { ownerGeneration: 1, opKey: expect.stringMatching(/^dispatch:/) },
    });
    const stale = runCli(["dispatch", "--task", "task_b", "--seat", "dev-1", "--generation", "2"], {
      POD_ORCA_FIXTURES: fixtures([ok("worker-start", started("ctx_9", "m-1"))]),
    });
    expect(stale.status).toBe(3);
    expect(stale.json.error?.code).toBe("owner_generation_stale");
  });
});
