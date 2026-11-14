import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import type { Size } from "../../src/core/domain/ledger.ts";
import { pointsOf } from "../../src/core/domain/points.ts";
import type { UsageRecord } from "../../src/core/domain/usage.ts";
import type { Db } from "../../src/core/ports/db.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { usageFacts } from "../../src/core/usage/facts.ts";
import {
  dayOf,
  dayWindow,
  recordCost,
  tokenTotal,
  usageDay,
  type UsageDay,
} from "../../src/core/usage/rollup.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { activeRevision, seedConfig } from "./seed.ts";

const la = "America/Los_Angeles";
const runtime = "example-runtime";
const model = "example-model";
const price = {
  input: 2,
  cached_input: 0.5,
  cache_write: 4,
  output: 20,
  per: 1000000,
};

function t(text: string): Date {
  return new Date(text);
}

test("dayWindow gives a 25 hour day on the fall-back change and dayOf reads the zone", () => {
  expect(dayWindow("2026-11-01", la)).toEqual({
    since: t("2026-11-01T07:00:00Z"),
    until: t("2026-11-02T08:00:00Z"),
  });
  expect(dayWindow("2026-11-10", "UTC")).toEqual({
    since: t("2026-11-10T00:00:00Z"),
    until: t("2026-11-11T00:00:00Z"),
  });
  expect(dayOf(t("2026-11-11T07:30:00Z"), la)).toBe("2026-11-10");
  expect(dayOf(t("2026-11-11T07:30:00Z"), "UTC")).toBe("2026-11-11");
});

test("pointsOf is the inverse of the estimate scale and null for an unknown scale", () => {
  const sizes: Size[] = ["xs", "s", "m", "l", "xl"];
  expect(sizes.map((size) => pointsOf(size, "fibonacci"))).toEqual([
    1, 2, 3, 5, 8,
  ]);
  expect(sizes.map((size) => pointsOf(size, "tshirt"))).toEqual([
    1, 2, 3, 4, 5,
  ]);
  expect(pointsOf("s", "unknown-scale")).toBeNull();
});

function bare(fields: Partial<UsageRecord>): UsageRecord {
  return {
    id: 1,
    runtime,
    session_id: "s",
    model,
    input: 1000,
    cached_input: 0,
    cache_write: 0,
    output: 100,
    reasoning: null,
    calls: 1,
    first_at: t("2026-11-10T00:00:00Z"),
    through: t("2026-11-10T00:00:00Z"),
    dispatch_id: null,
    run_id: null,
    attribution: "unattributed",
    coverage: "measured",
    op_key: "op",
    created_at: t("2026-11-10T00:00:00Z"),
    ...fields,
  };
}

test("a record with a null priced class costs unknown, never 0, and a null reasoning keeps the cost", () => {
  const listed = {
    basis: "list-price equivalent" as const,
    cost: 0,
    currency: "XXX",
    reason: null,
    rate_revision_id: "rate",
  };
  expect(recordCost(bare({ output: null }), listed)).toEqual({
    basis: "list-price equivalent",
    amount: null,
    currency: null,
    reason: "unmeasured",
  });
  expect(recordCost(bare({}), { ...listed, cost: 0.004 })).toEqual({
    basis: "list-price equivalent",
    amount: 0.004,
    currency: "XXX",
    reason: null,
  });
  expect(
    tokenTotal({
      input: 1,
      cached_input: 1,
      cache_write: 1,
      output: 1,
      reasoning: null,
    }),
  ).toBeNull();
});

describeDb("usage rollup", () => {
  let conn: Connection;
  let db: Db;
  let rate: Revision;
  let seeded: Awaited<ReturnType<typeof seedConfig>>;
  let ops = 0;

  async function op(key: string, intent: "dispatch" | "usage"): Promise<void> {
    await db.insertOperation({
      op_key: key,
      intent,
      owner_generation: 1,
      at: t("2026-11-09T00:00:00Z"),
    });
  }

  async function seatRun(
    runId: string,
    size: Size,
    project: string | null,
  ): Promise<void> {
    const { crew, process, policy } = seeded;
    await db.upsertStory({
      provider: "linear",
      external_id: `story-${runId}`,
      size,
      stage: "impl",
      run_id: null,
      dependencies: [],
      synced_at: t("2026-11-09T00:00:00Z"),
      status: null,
      title: null,
      kickoff_line: null,
    });
    await db.insertRun({
      run_id: runId,
      story_provider: "linear",
      story_external_id: `story-${runId}`,
      host: "local",
      coordinator: `coordinator-${runId}`,
      owner_generation: 1,
      snapshot_hash: "hash",
      state: "active",
      created_at: t("2026-11-09T00:00:00Z"),
      coordinator_dispatch_id: null,
    });
    await db.insertSnapshot({
      run_id: runId,
      crew_revision_id: crew.id,
      process_revision_id: process.id,
      policy_revision_id: policy.id,
      rate_revision_id: rate.id,
      effective_gate_map: {},
      hash: "hash",
      pinned_at: t("2026-11-09T00:00:00Z"),
      project,
      profile: null,
    });
  }

  async function dispatch(
    id: string,
    runId: string,
    seat: string,
    createdAt: string,
    settledAt: string | null,
    retryOf: string | null = null,
  ): Promise<void> {
    await op(`launch:${id}`, "dispatch");
    await db.insertDispatch({
      dispatch_id: id,
      task_id: null,
      decision_id: null,
      run_id: runId,
      seat,
      role: "decider",
      requested_launch: {},
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: retryOf,
      op_key: `launch:${id}`,
      settlement: "open",
      terminal_handle: null,
      created_at: t(createdAt),
      settled_at: null,
      activity: "running",
      manifest_id: null,
      prompt_bytes: null,
    });
    if (settledAt !== null)
      await db.settleDispatch(id, {
        activity: "settled",
        settlement: "done",
        settled_at: t(settledAt),
        at: t(settledAt),
      });
  }

  async function record(
    session: string,
    through: string,
    owner: { dispatch_id?: string; run_id?: string },
    tokens: Partial<UsageRecord> = {},
    runtimeName = runtime,
  ): Promise<void> {
    ops += 1;
    await op(`usage:${ops}`, "usage");
    await db.insertUsageRecord({
      runtime: runtimeName,
      session_id: session,
      model,
      input: 1000,
      cached_input: 200,
      cache_write: 100,
      output: 50,
      reasoning: 10,
      calls: 1,
      first_at: t(through),
      through: t(through),
      dispatch_id: owner.dispatch_id ?? null,
      run_id: owner.run_id ?? null,
      attribution:
        owner.dispatch_id !== undefined
          ? "locator"
          : owner.run_id !== undefined
            ? "path"
            : "unattributed",
      coverage: "measured",
      op_key: `usage:${ops}`,
      created_at: t(through),
      ...tokens,
    });
  }

  async function done(runId: string, at: string): Promise<void> {
    const key = closeStepKey(runId, "done");
    const request = { run_id: runId, step: "done", report_hash: "hash" };
    await db.insertOperation({
      op_key: key,
      intent: "close",
      owner_generation: 1,
      at: t(at),
      result_ref: { request },
    });
    await db.moveOperation(
      key,
      "done",
      { request, result: { state: "done" } },
      t(at),
    );
  }

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    db = conn.db;
    await clearDb(conn);
    seeded = await seedConfig(db);
    rate = await activeRevision(db, "rate", "default", {
      currency: "XXX",
      prices: [{ runtime, model, ...price }],
    });
    await seatRun("run_a", "s", "alpha");
    await seatRun("run_b", "m", "alpha");
    await seatRun("run_c", "xl", null);
    await seatRun("run_d", "s", "beta");

    await dispatch(
      "d_a1",
      "run_a",
      "dev",
      "2026-11-10T16:00:00Z",
      "2026-11-10T18:00:00Z",
    );
    await dispatch(
      "d_a2",
      "run_a",
      "dev",
      "2026-11-10T18:00:00Z",
      "2026-11-10T19:00:00Z",
      "d_a1",
    );
    await record("s-a1", "2026-11-09T20:00:00Z", { dispatch_id: "d_a1" });
    await record("s-a2", "2026-11-10T18:30:00Z", { dispatch_id: "d_a2" });
    await record("s-apath", "2026-11-10T19:00:00Z", { run_id: "run_a" });
    await done("run_a", "2026-11-10T20:00:00Z");

    await dispatch(
      "d_b1",
      "run_b",
      "dev",
      "2026-11-10T09:00:00Z",
      "2026-11-10T10:00:00Z",
    );
    await dispatch(
      "d_b2",
      "run_b",
      "rev",
      "2026-11-10T10:00:00Z",
      "2026-11-10T10:30:00Z",
    );
    await record(
      "s-b1",
      "2026-11-10T10:00:00Z",
      { dispatch_id: "d_b1" },
      { output: null },
    );
    await done("run_b", "2026-11-10T12:00:00Z");

    await dispatch(
      "d_c1",
      "run_c",
      "dev",
      "2026-11-11T06:00:00Z",
      "2026-11-11T07:00:00Z",
    );
    await record("s-c1", "2026-11-11T07:00:00Z", { dispatch_id: "d_c1" });
    await done("run_c", "2026-11-11T07:30:00Z");

    await dispatch("d_d1", "run_d", "dev", "2026-11-10T11:00:00Z", null);
    await record("s-d1", "2026-11-10T11:30:00Z", { dispatch_id: "d_d1" });

    await record("s-loose", "2026-11-10T09:00:00Z", {});
    await record(
      "s-other",
      "2026-11-10T09:30:00Z",
      {},
      { model: "example-model-unpriced" },
      "other-runtime",
    );
  });
  afterAll(() => conn.close());

  async function day(
    date: string,
    zone: string,
    project: string | null = null,
  ): Promise<UsageDay> {
    const window = dayWindow(date, zone);
    return usageDay(
      await usageFacts(
        db,
        { kind: "day", day: date, ...window },
        zone,
        "fibonacci",
      ),
      { project },
    );
  }

  const full = {
    input: 1000,
    cached_input: 200,
    cache_write: 100,
    output: 50,
    reasoning: 10,
  };
  const recordAmount = (1000 * 2 + 200 * 0.5 + 100 * 4 + 50 * 20) / 1000000;
  const unknownTokens = {
    input: null,
    cached_input: null,
    cache_write: null,
    output: null,
    reasoning: null,
  };

  test("a Seat counts on its settle day with every locator record, the one through the day before included", async () => {
    const usage = await day("2026-11-10", "UTC");
    expect(usage.seats.map((seat) => seat.dispatch_id)).toEqual([
      "d_a1",
      "d_a2",
      "d_b1",
      "d_b2",
    ]);
    expect(usage.seats[0]).toEqual({
      dispatch_id: "d_a1",
      seat: "dev",
      run_id: "run_a",
      settled_at: "2026-11-10T18:00:00.000Z",
      tokens: full,
      running_minutes: 120,
      wall_minutes: 120,
      cost: {
        basis: "list-price equivalent",
        amount: recordAmount,
        currency: "XXX",
        reason: null,
      },
    });
  });

  test("a Run sums its retry Dispatch and its path record, and an unknown value never sums as 0", async () => {
    const usage = await day("2026-11-10", "UTC");
    const [a, b] = usage.runs;
    expect(a).toMatchObject({
      run_id: "run_a",
      project: "alpha",
      seats: 2,
      tokens: {
        input: 3000,
        cached_input: 600,
        cache_write: 300,
        output: 150,
        reasoning: 30,
      },
      running_minutes: 180,
      wall_minutes: 180,
    });
    expect(a?.cost.amount).toBeCloseTo(recordAmount * 3, 12);
    expect(b).toMatchObject({
      run_id: "run_b",
      seats: 2,
      tokens: unknownTokens,
      running_minutes: 90,
      cost: { amount: null, reason: "unmeasured" },
    });
    expect(
      usage.seats.find((seat) => seat.dispatch_id === "d_b1")?.cost,
    ).toEqual({
      basis: "list-price equivalent",
      amount: null,
      currency: null,
      reason: "unmeasured",
    });
    expect(usage.total.tokens).toEqual(unknownTokens);
    expect(usage.total.running_minutes).toBe(270);
  });

  test("per point counts Runs on their done day, lists the unknown ones, and follows the host time zone", async () => {
    const utc = await day("2026-11-10", "UTC");
    const total = 3 * (1000 + 200 + 100 + 50 + 10);
    expect(utc.points).toMatchObject({
      points_done: 5,
      tokens_per_point: Math.round(total / 2),
      minutes_per_point: Math.round((270 / 5) * 10) / 10,
      unknown: { points: [], tokens: ["run_b"], minutes: [] },
    });
    expect(
      utc.points.runs.map((row) => [row.run_id, row.points, row.tokens]),
    ).toEqual([
      ["run_b", 3, null],
      ["run_a", 2, total],
    ]);
    const local = await day("2026-11-10", la);
    expect(local.points.points_done).toBe(13);
    expect(local.points.runs.map((row) => row.run_id)).toContain("run_c");
    expect(
      (await day("2026-11-11", "UTC")).points.runs.map((row) => row.run_id),
    ).toEqual(["run_c"]);
  });

  test("unattributed lines per runtime, the project rows, and the coverage line", async () => {
    const usage = await day("2026-11-10", "UTC");
    expect(usage.unattributed).toEqual([
      {
        runtime: "example-runtime",
        records: 1,
        tokens: full,
        cost: {
          basis: "list-price equivalent",
          amount: recordAmount,
          currency: "XXX",
          reason: null,
        },
      },
      {
        runtime: "other-runtime",
        records: 1,
        tokens: full,
        cost: {
          basis: "list-price equivalent",
          amount: null,
          currency: null,
          reason: "unpriced",
        },
      },
    ]);
    expect(
      usage.projects.map((row) => [row.project, row.points.points_done]),
    ).toEqual([["alpha", 5]]);
    expect(usage.coverage).toEqual({
      tokens_source: { locator: 3, path: 1, unattributed: 2 },
      null_values: [{ runtime, session_id: "s-b1", model, fields: ["output"] }],
      no_record: ["d_b2"],
      unknown_minutes: [],
    });
  });

  test("--project keeps that project's Runs and drops the unattributed lines", async () => {
    const usage = await day("2026-11-10", "UTC", "beta");
    expect(usage.runs).toEqual([]);
    expect(usage.unattributed).toEqual([]);
    expect(usage.coverage.tokens_source).toEqual({
      locator: 0,
      path: 0,
      unattributed: 0,
    });
    const alpha = await day("2026-11-10", "UTC", "alpha");
    expect(alpha.runs.map((row) => row.run_id)).toEqual(["run_a", "run_b"]);
    expect(alpha.unattributed).toEqual([]);
  });

  test("the Run view is the Run's whole life, with an open Dispatch listed and its minutes unknown", async () => {
    const usage = usageDay(
      await usageFacts(
        db,
        { kind: "run", run_id: "run_d" },
        "UTC",
        "fibonacci",
      ),
      { project: null },
    );
    expect(usage).toMatchObject({
      day: null,
      since: null,
      until: null,
      run: "run_d",
    });
    expect(usage.seats).toEqual([
      expect.objectContaining({
        dispatch_id: "d_d1",
        settled_at: null,
        tokens: full,
        running_minutes: null,
        wall_minutes: null,
      }),
    ]);
    expect(usage.coverage.unknown_minutes).toEqual(["d_d1"]);
    expect(usage.points.runs).toEqual([]);
    const a = usageDay(
      await usageFacts(
        db,
        { kind: "run", run_id: "run_a" },
        "UTC",
        "fibonacci",
      ),
      { project: null },
    );
    expect(a.points.runs.map((row) => row.run_id)).toEqual(["run_a"]);
    expect(a.runs[0]?.seats).toBe(2);
  });

  test("pod usage --run R exits 0, --run with --day is usage, and a malformed --day is usage", () => {
    const run = runCli(["usage", "--run", "run_d", "--json"]);
    expect(run.status).toBe(0);
    expect(run.json.result).toMatchObject({
      day: null,
      run: "run_d",
      time_zone: "UTC",
    });
    expect(
      runCli(["usage", "--run", "run_d", "--day", "2026-11-10", "--json"])
        .status,
    ).toBe(2);
    expect(runCli(["usage", "--day", "2026-13-40", "--json"]).status).toBe(2);
    const daily = runCli(["usage", "--day", "2026-11-10", "--json"]);
    expect(daily.status).toBe(0);
    expect(daily.json.result).toMatchObject({
      day: "2026-11-10",
      time_zone: "UTC",
    });
  });
});
