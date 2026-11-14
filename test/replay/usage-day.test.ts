import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { parseRate } from "../../src/core/config/rate.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import {
  Attribution,
  parseUsage,
  RecordCoverage,
  type UsageRecord,
} from "../../src/core/domain/usage.ts";
import { listPrice, usageCost } from "../../src/core/usage/cost.ts";
import { recordUsage } from "../../src/core/usage/record.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { seatRun } from "../db/identity-fixture.ts";
import { activeRevision, seedConfig } from "../db/seed.ts";

const at = new Date("2026-11-10T08:00:00Z");
const host = "example-host";

function rateValue(output: number): Json {
  return {
    currency: "XXX",
    prices: [
      {
        runtime: "example-runtime",
        model: "example-model",
        input: 2,
        cached_input: 0.5,
        cache_write: 4,
        output,
        per: 1000000,
      },
    ],
  };
}

describeDb("usage-day", () => {
  let conn: Connection;
  let morning: Revision;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    const { crew, process, policy } = await seedConfig(conn.db);
    morning = await activeRevision(conn.db, "rate", "default", rateValue(20));
    await seatRun(conn.db, "run_a");
    await conn.db.insertSnapshot({
      run_id: "run_a",
      crew_revision_id: crew.id,
      process_revision_id: process.id,
      policy_revision_id: policy.id,
      rate_revision_id: morning.id,
      effective_gate_map: {},
      hash: "hash",
      pinned_at: at,
      project: null,
      profile: null,
    });
    await conn.db.insertOperation({
      op_key: "launch:d_seat",
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
    await conn.db.insertDispatch({
      dispatch_id: "d_seat",
      task_id: null,
      decision_id: null,
      run_id: "run_a",
      seat: "example-seat",
      role: "decider",
      requested_launch: { worktree: "id:example-repo::/work/run-a" },
      effective_launch: {
        transcript: { harness: "example-runtime", session_id: "s-seat" },
      },
      model_attribution: "unknown",
      retry_of: null,
      op_key: "launch:d_seat",
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity: "running",
      manifest_id: null,
      prompt_bytes: null,
    });
    await conn.db.appendEvent({
      type: "start",
      ts: at,
      host,
      run_id: "run_a",
      task_id: null,
      dispatch_id: "d_seat",
      op_key: "launch:d_seat",
      payload: {},
      source: { kind: "command", verb: "dispatch" },
    });
  });
  afterAll(() => conn.close());

  function ingest() {
    const parsed = parseUsage(
      readFileSync(new URL("usage-day/day.jsonl", import.meta.url), "utf8"),
    );
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    return recordUsage(conn.db, {
      usage: parsed.input,
      limits: { floor_percent: 50, stale_minutes: 30 },
      host,
      now: () => new Date("2026-11-10T17:00:00Z"),
    });
  }

  async function ledger() {
    const records = await conn.sql`
      select runtime, session_id, model, input, cached_input, cache_write,
        output, reasoning, calls, first_at::text, through::text, dispatch_id,
        run_id, attribution, coverage
      from ledger.usage_record order by runtime, session_id, model nulls first`;
    const observations = await conn.sql`
      select provider, value, coverage, window_start::text, window_end::text,
        observed_at::text, source
      from ledger.usage_observation order by observed_at, id`;
    return { records, observations };
  }

  test("a day of rows with a resend records each session once, and a second ingest leaves the same rows", async () => {
    const first = await ingest();
    expect(first).toMatchObject({ units: 14, duplicates: 4 });
    expect(
      first.sessions.map((row) => [
        row.session_id,
        row.attribution,
        row.dispatch_id ?? row.run_id,
        row.rows,
        row.outcome,
      ]),
    ).toEqual([
      ["s-seat", "locator", "d_seat", 1, "written"],
      ["s-path", "path", "run_a", 1, "written"],
      ["s-loose", "unattributed", null, 1, "written"],
      ["s-other", "unattributed", null, 1, "written"],
      ["s-late", "unattributed", null, 1, "written"],
    ]);
    expect(first.windows.map((row) => [row.window, row.pace])).toEqual([
      ["example-5h", "ok"],
      ["example-5h", "ok"],
      ["example-5h", "avoid"],
      ["example-week", "spend"],
    ]);
    const before = await ledger();
    expect(
      before.records.map((row) => [
        row["session_id"],
        row["model"],
        row["input"],
        row["cache_write"],
        row["reasoning"],
        row["calls"],
        row["coverage"],
      ]),
    ).toEqual([
      ["s-late", "example-model", "1000", "100", "50", 1, "measured"],
      ["s-loose", "example-model-unpriced", "2000", null, null, 2, "partial"],
      ["s-path", "example-model", "2000", "200", "100", 2, "measured"],
      ["s-seat", "example-model", "4000", "400", "200", 4, "measured"],
      ["s-other", null, "1000", "100", "50", null, "partial"],
    ]);
    expect(before.observations).toHaveLength(4);

    const second = await ingest();
    expect(second.sessions.map((row) => row.outcome)).toEqual([
      "nothing_new",
      "nothing_new",
      "nothing_new",
      "nothing_new",
      "nothing_new",
    ]);
    expect(second.windows.map((row) => row.outcome)).toEqual([
      "replayed",
      "replayed",
      "replayed",
      "replayed",
    ]);
    expect(await ledger()).toEqual(before);
  });

  async function records(): Promise<Map<string, UsageRecord>> {
    const rows = await conn.sql<Record<string, unknown>[]>`
      select * from ledger.usage_record order by id`;
    const count = (value: unknown) => (value === null ? null : Number(value));
    return new Map(
      rows.map((row) => [
        String(row["session_id"]),
        {
          id: Number(row["id"]),
          runtime: String(row["runtime"]),
          session_id: String(row["session_id"]),
          model: row["model"] === null ? null : String(row["model"]),
          input: count(row["input"]),
          cached_input: count(row["cached_input"]),
          cache_write: count(row["cache_write"]),
          output: count(row["output"]),
          reasoning: count(row["reasoning"]),
          calls: count(row["calls"]),
          first_at: row["first_at"] as Date,
          through: row["through"] as Date,
          dispatch_id: (row["dispatch_id"] as string | null) ?? null,
          run_id: (row["run_id"] as string | null) ?? null,
          attribution: Attribution.parse(row["attribution"]),
          coverage: RecordCoverage.parse(row["coverage"]),
          op_key: String(row["op_key"]),
          created_at: row["created_at"] as Date,
        },
      ]),
    );
  }

  async function costs() {
    const rows = await records();
    const read = async (session: string) => {
      const row = rows.get(session);
      if (row === undefined) throw new Error(`no record for ${session}`);
      return usageCost(conn.db, row);
    };
    return {
      seat: await read("s-seat"),
      path: await read("s-path"),
      late: await read("s-late"),
      loose: await read("s-loose"),
      other: await read("s-other"),
    };
  }

  test("a rate change mid-day keeps run_a on its pinned rate and prices unattributed rows at the rate active at read", async () => {
    const rows = await records();
    const priced = (session: string, id: string, output: number) => {
      const row = rows.get(session);
      if (row === undefined) throw new Error(`no record for ${session}`);
      return listPrice(row, { id, value: parseRate(rateValue(output)) });
    };
    const before = await costs();
    expect(before).toEqual({
      seat: priced("s-seat", morning.id, 20),
      path: priced("s-path", morning.id, 20),
      late: priced("s-late", morning.id, 20),
      loose: expect.objectContaining({ cost: null, reason: "unpriced" }),
      other: expect.objectContaining({ cost: null, reason: "unpriced" }),
    });
    expect(before.seat.cost).toBe(
      (4000 * 2 + 2400 * 0.5 + 400 * 4 + 800 * 20) / 1000000,
    );

    const afternoon = await storeRevision(
      conn.db,
      envelope("rate", "default", rateValue(30)),
    );
    const moved = await conn.db.activate({
      scope: "global",
      scope_ref: "",
      kind: "rate",
      name: "default",
      expected: morning.id,
      revision_id: afternoon.id,
      bundle_id: null,
      activated_by: "person:operator",
      activated_at: new Date("2026-11-10T12:00:00Z"),
    });
    expect(moved.ok).toBe(true);

    const after = await costs();
    expect(after.seat).toEqual(before.seat);
    expect(after.path).toEqual(before.path);
    expect(after.late).toEqual(priced("s-late", afternoon.id, 30));
    expect(after.late.cost).not.toBe(before.late.cost);
    expect(after.loose).toEqual({
      ...before.loose,
      rate_revision_id: afternoon.id,
    });
    expect(after.other).toEqual({
      ...before.other,
      rate_revision_id: afternoon.id,
    });
  });
});
