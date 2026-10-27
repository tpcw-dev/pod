import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import {
  lost,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  devArgv,
  dispatchInput,
  empty,
  events,
  freshRun,
  replay,
  started,
  taskState,
  worktreeId,
  workers,
} from "./run-fixture.ts";

const requestId = "55555555-5555-4555-8555-555555555555";
const run = ["--run", "run_1"];
const replayArgv = [
  ...devArgv,
  "--worktree",
  "current",
  "--retry-request",
  requestId,
];

describeDb("pod check reconciles unknown launches", () => {
  let conn: Connection;
  let opKey: string;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  async function launchUnknown(entry: TempEntry): Promise<void> {
    const { orca, log } = replay(conn, [entry]);
    const outcome = await dispatch(
      conn.db,
      orca,
      log,
      dispatchInput({ capacity: 1 }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    const [row] = await conn.sql<{ op_key: string }[]>`
      select op_key from ledger.operation where intent = 'dispatch'`;
    opKey = row?.op_key ?? "";
  }

  async function pass(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 1,
      now: () => new Date(),
    });
    orca.assertDone();
    return outcome;
  }

  async function status() {
    return (await conn.db.getOperation(opKey))?.status;
  }

  const shown = (state: string) =>
    ok("request-show", { requestId, state }, ["--request", requestId]);

  test("completed replays through --retry-request and records one Dispatch", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      shown("completed"),
      ok("worker-start", started("ctx_1"), replayArgv),
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "ready" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        reconciled: [{ op_key: opKey, to: "dispatched" }],
        unknown_workers: [],
        free_slots: 0,
      },
    });
    expect(await status()).toBe("done");
    expect(await taskState(conn, "task_b")).toBe("dispatched");
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      op_key: opKey,
      settlement: "open",
      requested_launch: { worktree: `id:${worktreeId}` },
    });
    expect((await events(conn, "start")).map((row) => row.dispatch_id)).toEqual(
      ["ctx_1"],
    );
  });

  test("pending with no worker stays unknown and keeps its slot; with a worker it records the Dispatch", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const waiting = await pass([
      shown("pending"),
      ok("worker-list", workers([]), run),
      ok("check", empty(), run),
    ]);
    expect(waiting).toMatchObject({
      ok: true,
      result: { reconciled: [{ to: "unknown" }], free_slots: 0 },
    });
    expect(await status()).toBe("unknown");
    expect(await taskState(conn, "task_b")).toBe("hold");
    await pass([
      shown("pending"),
      ok(
        "worker-list",
        workers([
          {
            dispatchId: "ctx_2",
            workerState: "ready",
            worktreeId: "repo-2::/w/two",
          },
        ]),
        run,
      ),
      ok("check", empty(), run),
    ]);
    expect(await status()).toBe("done");
    expect(await conn.db.getDispatch("ctx_2")).toMatchObject({
      model_attribution: "unknown",
      terminal_handle: null,
      requested_launch: {
        agent: "claude",
        model: "m-1",
        effort: "low",
        worktree: "id:repo-2::/w/two",
      },
    });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
  });

  test("an unreadable request-show keeps the operation unknown and the Task held", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      {
        verb: "request-show",
        argv: ["--request", requestId],
        exitCode: 1,
        stdout: "not json",
      },
      ok("worker-list", workers([]), run),
      ok("check", empty(), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        reconciled: [{ to: "unknown" }],
        free_slots: 0,
        nextSteps: expect.arrayContaining([
          `pod check: launch ${opKey} is still unknown`,
        ]),
      },
    });
    expect(await status()).toBe("unknown");
    expect(await taskState(conn, "task_b")).toBe("hold");
  });

  const replayed = (stdout: string): TempEntry => ({
    verb: "worker-start",
    argv: replayArgv,
    exitCode: 1,
    stdout,
  });
  const refusal = (code: string, data?: object) =>
    replayed(
      JSON.stringify({ ok: false, error: { code, message: "no", data } }),
    );

  test.each([
    ["a runtime_unavailable envelope", refusal("runtime_unavailable")],
    [
      "an orca_version_unsupported envelope",
      refusal("orca_version_unsupported"),
    ],
    ["a consumer_fenced envelope", refusal("consumer_fenced")],
    [
      "an outcome_unknown disposition",
      refusal("task_not_startable", {
        recovery: { disposition: "outcome_unknown" },
      }),
    ],
    ["stdout that is not json", replayed("not json")],
    [
      "an envelope without ok: false",
      replayed(JSON.stringify({ error: { code: "task_not_startable" } })),
    ],
  ])(
    "a completed request whose replay fails keeps the operation unknown and sends no second start: %s",
    async (_name, reply) => {
      await launchUnknown(unknownReply("worker-start", requestId));
      const outcome = await pass([
        shown("completed"),
        reply,
        ok("worker-list", workers([]), run),
        ok("check", empty(), run),
      ]);
      expect(outcome).toMatchObject({
        ok: true,
        result: { reconciled: [{ to: "unknown" }], free_slots: 0 },
      });
      expect(await status()).toBe("unknown");
      expect(await taskState(conn, "task_b")).toBe("hold");
    },
  );

  test("a completed request whose replay returns a recorded refusal and no worker frees the Task", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      shown("completed"),
      refusal("task_not_startable"),
      ok("worker-list", workers([]), run),
      ok("check", empty(), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [{ op_key: opKey, to: "ready" }], free_slots: 1 },
    });
    expect(await conn.db.getOperation(opKey)).toMatchObject({
      status: "done",
      result_ref: {
        outcome: "failed",
        reconciled: "recorded_refusal",
        code: "task_not_startable",
      },
    });
    expect(await taskState(conn, "task_b")).toBe("ready");
    expect(
      (await events(conn, "resume")).map((row) => row.payload["reason"]),
    ).toEqual(["reconciled_no_worker"]);
  });

  test("a recorded refusal with an unreadable worker list keeps the operation unknown", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      shown("completed"),
      refusal("task_not_startable"),
      { verb: "worker-list", argv: run, exitCode: 1, stdout: "not json" },
      ok("check", empty(), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [{ to: "unknown" }], free_slots: 0 },
    });
    expect(await status()).toBe("unknown");
    expect(await taskState(conn, "task_b")).toBe("hold");
  });

  test("a recorded refusal with an unrecorded worker for the Task records its Dispatch", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      shown("completed"),
      refusal("task_not_startable"),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_4", workerState: "ready" }]),
        run,
      ),
      ok("check", empty(), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [{ to: "dispatched" }] },
    });
    expect(await status()).toBe("done");
    expect(await conn.db.getDispatch("ctx_4")).toMatchObject({ op_key: opKey });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
  });

  test("absent with no worker finishes the operation and frees the Task with a resume event", async () => {
    await launchUnknown(unknownReply("worker-start", requestId));
    const outcome = await pass([
      shown("absent"),
      ok("worker-list", workers([]), run),
      ok("check", empty(), run),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [{ to: "ready" }], free_slots: 1 },
    });
    expect(await conn.db.getOperation(opKey)).toMatchObject({
      status: "done",
      result_ref: { outcome: "failed", reconciled: "no_worker" },
    });
    expect(await taskState(conn, "task_b")).toBe("ready");
    expect(
      (await events(conn, "resume")).map((row) => row.payload["reason"]),
    ).toEqual(["reconciled_no_worker"]);
  });

  test("the SIGKILL form reads the worker list both ways", async () => {
    await launchUnknown(lost("worker-start"));
    await pass([
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_3", workerState: "ready" }]),
        run,
      ),
      ok("check", empty(), run),
    ]);
    expect(await conn.db.getDispatch("ctx_3")).not.toBeNull();
    expect(await taskState(conn, "task_b")).toBe("dispatched");

    await freshRun(conn);
    await launchUnknown(lost("worker-start"));
    await pass([
      ok("worker-list", workers([]), run),
      ok("check", empty(), run),
    ]);
    expect(await status()).toBe("done");
    expect(await taskState(conn, "task_b")).toBe("ready");
  });

  test("a pending launch row is never reconciled", async () => {
    await conn.db.insertOperation({
      op_key: "in-flight",
      intent: "dispatch",
      owner_generation: 1,
      at: new Date(),
      result_ref: {
        request: { task_id: "task_b", seat: "dev-1", host: "local" },
      },
    });
    const outcome = await pass([
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_live", workerState: "ready" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [], unknown_workers: [] },
    });
    expect((await conn.db.getOperation("in-flight"))?.status).toBe("pending");
  });
});
