import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type {
  Dispatch,
  NewEvent,
  Run,
  Story,
  Task,
} from "../../src/core/domain/ledger.ts";
import { runBlocked } from "../../src/core/ledger/run-blocked.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

const at = new Date("2026-10-25T00:00:00Z");

function later(seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}

function eventOf(type: NewEvent["type"], ts: Date): NewEvent {
  return {
    type,
    ts,
    host: "local",
    run_id: "run-1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: {},
    source: { kind: "command", verb: "check" },
  };
}

describeDb("ledger repositories", () => {
  let conn: Connection;
  const story: Story = {
    provider: "tracker",
    external_id: "S-1",
    size: "s",
    stage: "impl",
    run_id: null,
    dependencies: [],
    synced_at: at,
    status: null,
    title: null,
    kickoff_line: null,
  };
  const run: Run = {
    run_id: "run-1",
    story_provider: "tracker",
    story_external_id: "S-1",
    host: "local",
    coordinator: "session-1",
    owner_generation: 1,
    snapshot_hash: "h",
    state: "active",
    created_at: at,
  };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("a story upserts on its key", async () => {
    await conn.db.upsertStory(story);
    await conn.db.upsertStory({
      ...story,
      stage: "review",
      run_id: "run-1",
      dependencies: ["S-0"],
    });
    expect(await conn.db.getStory("tracker", "S-1")).toEqual({
      ...story,
      stage: "review",
      run_id: "run-1",
      dependencies: ["S-0"],
    });
  });

  test("a run, a task, and a dispatch round-trip", async () => {
    const spec = await storeRevision(
      conn.db,
      envelope("task", "lineage-1", { goal: "build" }),
    );
    await conn.db.insertRun(run);
    expect(await conn.db.getRun("run-1")).toEqual(run);
    const task: Task = {
      task_id: "task-1",
      run_id: "run-1",
      step_id: "build",
      lineage_id: "lineage-1",
      role: "developer",
      deps: [],
      spec_revision_id: spec.id,
      rework_of: null,
      state: "ready",
      created_at: at,
    };
    await conn.db.insertTask(task);
    expect(await conn.db.getTask("task-1")).toEqual(task);
    await conn.db.insertOperation({
      op_key: "op-d",
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
    const dispatch: Dispatch = {
      dispatch_id: "ctx-1",
      task_id: "task-1",
      run_id: "run-1",
      seat: "seat-a",
      role: "developer",
      requested_launch: { model: "m" },
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: "op-d",
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity: "running",
      manifest_id: null,
    };
    await conn.db.insertDispatch(dispatch);
    expect(await conn.db.getDispatch("ctx-1")).toEqual(dispatch);
    const [reserved] = await conn.sql`
      select execution_backend, owner_host, external_execution_id, auth_ref, output_ref
      from ledger.dispatch where dispatch_id = 'ctx-1'`;
    expect(reserved).toEqual({
      execution_backend: null,
      owner_host: null,
      external_execution_id: null,
      auth_ref: null,
      output_ref: null,
    });
  });

  test("an operation moves forward only", async () => {
    const created = await conn.db.insertOperation({
      op_key: "op-1",
      intent: "drain",
      owner_generation: 1,
      at,
    });
    expect(created).toMatchObject({
      created: true,
      operation: { status: "pending", result_ref: null },
    });
    expect(
      await conn.db.insertOperation({
        op_key: "op-1",
        intent: "drain",
        owner_generation: 1,
        at: later(1),
      }),
    ).toMatchObject({
      created: false,
      operation: { status: "pending", created_at: at },
    });
    expect(
      await conn.db.moveOperation("op-1", "unknown", null, later(2)),
    ).toMatchObject({ status: "unknown" });
    await expect(
      conn.db.moveOperation("op-1", "pending", null, later(3)),
    ).rejects.toThrow("cannot move from unknown to pending");
    expect(
      await conn.db.moveOperation("op-1", "done", { ok: true }, later(4)),
    ).toMatchObject({
      status: "done",
      result_ref: { ok: true },
      updated_at: later(4),
    });
    await expect(
      conn.db.moveOperation("op-1", "unknown", null, later(5)),
    ).rejects.toThrow("cannot move from done to unknown");
    await conn.db.insertOperation({
      op_key: "op-2",
      intent: "drain",
      owner_generation: 1,
      at,
    });
    await conn.db.moveOperation("op-2", "refused", null, later(1));
    await expect(
      conn.db.moveOperation("op-2", "done", null, later(2)),
    ).rejects.toThrow("cannot move from refused to done");
  });

  test("an event appends and reads back", async () => {
    const appended = await conn.db.appendEvent(eventOf("receipt", at));
    expect(appended).toEqual({ ...eventOf("receipt", at), id: appended.id });
  });

  test("runBlocked finds the earliest stop or cancel", async () => {
    expect(await runBlocked(conn.db, "run-1")).toBeNull();
    const cancel = await conn.db.appendEvent(eventOf("cancel", later(10)));
    expect(await runBlocked(conn.db, "run-1")).toEqual(cancel);
    await conn.db.appendEvent(eventOf("stop", later(20)));
    expect(await runBlocked(conn.db, "run-1")).toEqual(cancel);
    const stop = await conn.db.appendEvent({
      ...eventOf("stop", later(5)),
      run_id: "run-2",
    });
    expect(await runBlocked(conn.db, "run-2")).toEqual(stop);
  });

  test("runBlocked skips a stop that names a Dispatch", async () => {
    const run3 = { ...eventOf("stop", later(1)), run_id: "run-3" };
    await conn.db.appendEvent({ ...run3, dispatch_id: "ctx-9" });
    expect(await runBlocked(conn.db, "run-3")).toBeNull();
    const cancel = await conn.db.appendEvent({
      ...eventOf("cancel", later(2)),
      run_id: "run-3",
      dispatch_id: "ctx-9",
    });
    expect(await runBlocked(conn.db, "run-3")).toEqual(cancel);
  });

  test("a Dispatch settles once, while it is open", async () => {
    const change = {
      activity: "settled" as const,
      settlement: "done",
      settled_at: later(30),
    };
    expect(await conn.db.settleDispatch("ctx-1", change)).toBe(true);
    expect(
      await conn.db.settleDispatch("ctx-1", {
        ...change,
        settlement: "failed",
      }),
    ).toBe(false);
    expect(await conn.db.getDispatch("ctx-1")).toMatchObject({
      activity: "settled",
      settlement: "done",
      settled_at: later(30),
    });
  });

  test("a Dispatch's earliest event of a type and a recorded message id read back", async () => {
    const first = await conn.db.appendEvent({
      ...eventOf("start", later(40)),
      dispatch_id: "ctx-1",
      payload: { message_id: "msg-1" },
    });
    await conn.db.appendEvent({
      ...eventOf("start", later(41)),
      dispatch_id: "ctx-1",
    });
    expect(await conn.db.dispatchEvent("ctx-1", "start")).toEqual(first);
    expect(await conn.db.dispatchEvent("ctx-1", "release")).toBeNull();
    expect(await conn.db.messageRecorded("run-1", "msg-1")).toBe(true);
    expect(await conn.db.messageRecorded("run-1", "msg-2")).toBe(false);
    expect(await conn.db.messageRecorded("run-2", "msg-1")).toBe(false);
  });

  test("operations list by intent and status", async () => {
    await conn.db.insertOperation({
      op_key: "op-r",
      intent: "release",
      owner_generation: 1,
      at: later(50),
    });
    expect(
      (await conn.db.listOperations(["release"], ["pending"])).map(
        (row) => row.op_key,
      ),
    ).toEqual(["op-r"]);
    expect(await conn.db.listOperations(["release"], ["done"])).toEqual([]);
  });
});
