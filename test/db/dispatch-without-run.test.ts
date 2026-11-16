import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { migrate } from "../../src/adapters/postgres/migrate.ts";
import { CheckInput } from "../../src/cli/run-verbs.ts";
import { observeRunless } from "../../src/core/check/runless.ts";
import { launchSlotRefusal } from "../../src/core/dispatch/launch-gate.ts";
import { insertStart } from "../../src/core/dispatch/launch-record.ts";
import { release } from "../../src/core/dispatch/release.ts";
import { stopDispatch } from "../../src/core/dispatch/stop.ts";
import { derivedOpKey } from "../../src/core/ledger/op-key.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { usageCost } from "../../src/core/usage/cost.ts";
import { usageFacts } from "../../src/core/usage/facts.ts";
import { dayWindow, usageDay } from "../../src/core/usage/rollup.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { dbUrl, describeDb, openDb, resetDb } from "./helpers.ts";
import { openLaunch, seatRun } from "./identity-fixture.ts";
import { freshRun, replay, workers } from "./run-fixture.ts";
import { activeRevision } from "./seed.ts";

const runtime = "example-runtime";
const model = "example-model";

async function runless(
  conn: Connection,
  dispatchId: string,
  over: { host?: string; at?: Date; terminal?: string | null } = {},
): Promise<void> {
  const opKey = `launch:${dispatchId}`;
  const at = over.at ?? new Date();
  await openLaunch(conn.db, opKey);
  await conn.db.moveOperation(opKey, "done", null, at);
  await conn.db.transaction((tx) =>
    insertStart(tx, {
      owner: { task_id: null, decision_id: null },
      run_id: null,
      role: "digest",
      seat: "meta-digest",
      host: over.host ?? "local",
      launched: {
        dispatchId,
        terminalHandle:
          over.terminal === undefined ? `term_${dispatchId}` : over.terminal,
        requested: null,
        effective: null,
        worktreeId: null,
      },
      requested_launch: {},
      model_attribution: "unknown",
      retry_of: null,
      fallback_of: null,
      op_key: opKey,
      manifest_id: null,
      prompt_bytes: null,
      verb: "tick",
      late: false,
      at,
    }),
  );
}

async function stopEvents(conn: Connection, dispatchId: string) {
  return conn.sql<
    { run_id: string | null; payload: Record<string, unknown> }[]
  >`select run_id, payload from ledger.event where type = 'stop' and dispatch_id = ${dispatchId} order by id`;
}

function allWorkers(
  rows: { dispatchId: string; workerState: string }[],
  source = "all",
): TempEntry {
  return ok("worker-list", {
    ...(workers(rows) as Record<string, unknown>),
    scope: { source },
  });
}

describeDb("a Dispatch with no Run", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => freshRun(conn));
  afterAll(() => conn.close());

  test("the owner check admits a Dispatch with no Run, Task, or Decision, and refuses a Run-less one with a Task or a Decision", async () => {
    await runless(conn, "ctx_meta");
    expect(await conn.db.getDispatch("ctx_meta")).toMatchObject({
      run_id: null,
      task_id: null,
      decision_id: null,
      owner_host: "local",
    });
    const insert = (id: string, column: "task_id" | "decision_id") =>
      conn.sql.unsafe(
        `insert into ledger.dispatch (dispatch_id, ${column}, seat, role, requested_launch, model_attribution, op_key, settlement, created_at, activity, owner_host)
         values ('${id}', 'x', 'seat', 'digest', '{}', 'unknown', 'launch:ctx_meta', 'open', now(), 'running', 'local')`,
      );
    await expect(insert("ctx_task", "task_id")).rejects.toThrow(
      /dispatch_owner_check/,
    );
    await expect(
      conn.sql`insert into ledger.dispatch (dispatch_id, task_id, seat, role, requested_launch, model_attribution, op_key, settlement, created_at, activity, owner_host)
        values ('ctx_task2', 'task_b', 'seat', 'developer', '{}', 'unknown', 'launch:ctx_meta', 'open', now(), 'running', 'local')`,
    ).rejects.toThrow(/dispatch_owner_check/);
    await expect(insert("ctx_dec", "decision_id")).rejects.toThrow(
      /dispatch_owner_check/,
    );
    await expect(
      conn.db.transaction(async (tx) => {
        await openLaunch(tx, "launch:ctx_bad");
        await insertStart(tx, {
          owner: { task_id: "task_b", decision_id: null },
          run_id: null,
          role: "developer",
          seat: "dev-1",
          host: "local",
          launched: {
            dispatchId: "ctx_bad",
            terminalHandle: null,
            requested: null,
            effective: null,
            worktreeId: null,
          },
          requested_launch: {},
          model_attribution: "unknown",
          retry_of: null,
          op_key: "launch:ctx_bad",
          manifest_id: null,
          prompt_bytes: null,
          verb: "tick",
          late: false,
          at: new Date(),
        });
      }),
    ).rejects.toThrow("a Dispatch with no Run has no Task or Decision");
  });

  test("a running Run-less Dispatch takes a slot on its owner host and not on another host", async () => {
    await runless(conn, "ctx_meta");
    expect(await conn.db.hostActivities("local")).toEqual(["running"]);
    expect(await conn.db.hostActivities("elsewhere")).toEqual([]);
  });

  test("it takes an ordinary slot, counts under no project, and leaves a reserved project's share alone", async () => {
    await runless(conn, "ctx_meta");
    expect(await conn.db.hostRunningByProject("local")).toEqual({});
    expect(
      await launchSlotRefusal(conn.db, "local", "beta", 2, { alpha: 1 }),
    ).toMatchObject({ code: "quota_exhausted" });
    expect(
      await launchSlotRefusal(conn.db, "local", "beta", 3, { alpha: 1 }),
    ).toBeNull();
    expect(
      await launchSlotRefusal(conn.db, "local", "alpha", 2, { alpha: 1 }),
    ).toBeNull();
  });

  test("its terminal resolves as its Seat on its owner host", async () => {
    await runless(conn, "ctx_meta");
    await runless(conn, "ctx_bare", { terminal: null });
    expect(await conn.db.terminalSeat("local", "term_ctx_meta")).toBe(
      "meta-digest",
    );
    expect(await conn.db.terminalSeat("elsewhere", "term_ctx_meta")).toBe(null);
    expect(await conn.db.unresolvedWorkers("local")).toContain("ctx_bare");
    expect(await conn.db.unresolvedWorkers("elsewhere")).not.toContain(
      "ctx_bare",
    );
  });

  test("release works with no owner generation compare and refuses a caller on another host", async () => {
    await runless(conn, "ctx_meta");
    await conn.sql`update ledger.dispatch set settlement = 'done', activity = 'settled', settled_at = now() where dispatch_id = 'ctx_meta'`;
    const input = {
      dispatch: "ctx_meta",
      generation: 99,
      retain: null,
      host: "local",
      now: () => new Date(),
    };
    const elsewhere = await release(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      { ...input, host: "elsewhere" },
    );
    expect(elsewhere).toMatchObject({
      ok: false,
      refusal: { code: "release_refused" },
    });
    const { orca, log } = replay(conn, [
      ok("worker-release", { dispatchId: "ctx_meta", state: "released" }, [
        "--dispatch",
        "ctx_meta",
      ]),
    ]);
    const outcome = await release(conn.db, orca, log, input);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { dispatch_id: "ctx_meta", state: "released" },
      opKey: derivedOpKey("release", {
        dispatch_id: "ctx_meta",
        attempt: "1",
      }),
    });
    const [event] = await conn.sql<{ run_id: string | null }[]>`
      select run_id from ledger.event where type = 'release' and dispatch_id = 'ctx_meta'`;
    expect(event).toEqual({ run_id: null });
  });

  test("usage prices it at the active rate, lists it with run_id null, and counts it in the day total only", async () => {
    const rate = await activeRevision(conn.db, "rate", "default", {
      currency: "XXX",
      prices: [
        {
          runtime,
          model,
          input: 2,
          cached_input: 0.5,
          cache_write: 4,
          output: 20,
          per: 1000000,
        },
      ],
    });
    const at = new Date("2026-11-10T12:00:00Z");
    await runless(conn, "ctx_meta", { at });
    await conn.db.settleDispatch("ctx_meta", {
      activity: "settled",
      settlement: "done",
      settled_at: new Date("2026-11-10T13:00:00Z"),
      at: new Date("2026-11-10T13:00:00Z"),
    });
    await conn.db.insertOperation({
      op_key: "usage:1",
      intent: "usage",
      owner_generation: 1,
      at,
    });
    const record = await conn.db.insertUsageRecord({
      runtime,
      session_id: "s-meta",
      model,
      input: 1000,
      cached_input: 0,
      cache_write: 0,
      output: 100,
      reasoning: null,
      calls: 1,
      first_at: at,
      through: at,
      dispatch_id: "ctx_meta",
      run_id: null,
      attribution: "locator",
      coverage: "measured",
      op_key: "usage:1",
      created_at: at,
    });
    const amount = (1000 * 2 + 100 * 20) / 1000000;
    expect(await usageCost(conn.db, record)).toMatchObject({
      cost: amount,
      rate_revision_id: rate.id,
    });
    const day = async (project: string | null) =>
      usageDay(
        await usageFacts(
          conn.db,
          {
            kind: "day",
            day: "2026-11-10",
            ...dayWindow("2026-11-10", "UTC"),
          },
          "UTC",
          "fibonacci",
        ),
        { project },
      );
    const usage = await day(null);
    expect(usage.seats).toMatchObject([
      { dispatch_id: "ctx_meta", seat: "meta-digest", run_id: null },
    ]);
    expect(usage.runs).toEqual([]);
    expect(usage.projects).toEqual([]);
    expect(usage.total).toMatchObject({
      tokens: { input: 1000, output: 100 },
      cost: { amount, currency: "XXX" },
    });
    expect((await day("alpha")).seats).toEqual([]);
  });

  test("pod check --observe takes no --run", () => {
    expect(CheckInput.safeParse({ args: [], observe: true }).success).toBe(
      true,
    );
    expect(
      CheckInput.safeParse({ args: [], observe: true, generation: "1" })
        .success,
    ).toBe(false);
  });

  test("the Run-less observe settles a stopped one and lists a missing one, leaving it open", async () => {
    await runless(conn, "ctx_stopped");
    await runless(conn, "ctx_missing");
    await runless(conn, "ctx_far", { host: "elsewhere" });
    const { orca, log } = replay(conn, [
      allWorkers([{ dispatchId: "ctx_stopped", workerState: "stopped" }]),
    ]);
    const outcome = await observeRunless(conn.db, orca, log, {
      host: "local",
      capacity: 2,
      now: () => new Date(),
    });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        run_id: null,
        stopped: ["ctx_stopped"],
        unknown_workers: ["ctx_missing"],
      },
    });
    expect(await conn.db.getDispatch("ctx_stopped")).toMatchObject({
      settlement: "stopped",
      activity: "settled",
    });
    expect(await conn.db.getDispatch("ctx_missing")).toMatchObject({
      settlement: "open",
    });
    expect(await stopEvents(conn, "ctx_stopped")).toEqual([
      {
        run_id: null,
        payload: { reason: "worker_stopped", worker_state: "stopped" },
      },
    ]);
  });

  test("the Run-less observe settles nothing when the worker list covers only a bound Run", async () => {
    await runless(conn, "ctx_stopped");
    const { orca, log } = replay(conn, [
      allWorkers(
        [{ dispatchId: "ctx_stopped", workerState: "stopped" }],
        "bound",
      ),
    ]);
    const outcome = await observeRunless(conn.db, orca, log, {
      host: "local",
      capacity: 2,
      now: () => new Date(),
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { stopped: [], unknown_workers: [] },
    });
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.result.nextSteps.join("\n")).toContain("scope bound");
    expect(await conn.db.getDispatch("ctx_stopped")).toMatchObject({
      settlement: "open",
    });
  });

  test("the stop path stops and settles a Run-less Dispatch with its reason in the stop event", async () => {
    await runless(conn, "ctx_meta");
    const { orca, log } = replay(conn, [
      ok("worker-stop", { dispatchId: "ctx_meta", state: "stopped" }, [
        "--dispatch",
        "ctx_meta",
      ]),
    ]);
    const dispatch = await conn.db.getDispatch("ctx_meta");
    if (dispatch === null) throw new Error("no Dispatch");
    const stopped = await stopDispatch(conn.db, orca, log, {
      dispatch,
      cause: { reason: "resume" },
      requestId: null,
      unknown: false,
      workers: () => Promise.resolve([]),
      host: "local",
      now: () => new Date(),
    });
    orca.assertDone();
    expect(stopped).toEqual({ kind: "settled" });
    expect(await conn.db.getDispatch("ctx_meta")).toMatchObject({
      settlement: "stopped",
      activity: "settled",
    });
    const [event] = await stopEvents(conn, "ctx_meta");
    expect(event?.run_id).toBeNull();
    expect(event?.payload).toMatchObject({ reason: "resume" });
    expect(event?.payload).not.toHaveProperty("decision_id");
  });
});

function journalThrough(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), "pod-migrations-"));
  cpSync("db/migrations", folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((entry) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(path, JSON.stringify(journal));
  return folder;
}

describeDb("migration 0027", () => {
  beforeAll(resetDb);

  test("a migrated database gives each existing Dispatch its Run's host as owner_host", async () => {
    const conn = openDb();
    try {
      await conn.sql`set client_min_messages = warning`;
      await conn.sql`drop schema if exists config, ledger, drizzle cascade`;
      expect(
        await migrate(dbUrl(), journalThrough("0026_learning_reporter_digest")),
      ).toMatchObject({ kind: "ok", applied: 27 });
      await seatRun(conn.db, "run-near", { host: "host-a" });
      await seatRun(conn.db, "run-far", { host: "host-b" });
      for (const [id, runId] of [
        ["ctx_near", "run-near"],
        ["ctx_far", "run-far"],
      ] as const) {
        await openLaunch(conn.db, `launch:${id}`);
        await conn.sql`insert into ledger.dispatch (dispatch_id, run_id, seat, role, requested_launch, model_attribution, op_key, settlement, created_at, activity)
          values (${id}, ${runId}, 'dec-1', 'decider', '{}', 'unknown', ${`launch:${id}`}, 'open', now(), 'running')`;
      }
      expect(await migrate(dbUrl(), "db/migrations")).toMatchObject({
        kind: "ok",
        applied: 3,
      });
      expect(
        await conn.sql`select dispatch_id, owner_host from ledger.dispatch order by dispatch_id`,
      ).toEqual([
        { dispatch_id: "ctx_far", owner_host: "host-b" },
        { dispatch_id: "ctx_near", owner_host: "host-a" },
      ]);
    } finally {
      await conn.close();
    }
  });
});
