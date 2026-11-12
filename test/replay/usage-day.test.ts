import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { parseUsage } from "../../src/core/domain/usage.ts";
import { recordUsage } from "../../src/core/usage/record.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { seatRun } from "../db/identity-fixture.ts";

const at = new Date("2026-11-10T08:00:00Z");
const host = "example-host";

describeDb("usage-day", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await seatRun(conn.db, "run_a");
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
    expect(first).toMatchObject({ units: 13, duplicates: 4 });
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
    ]);
    expect(second.windows.map((row) => row.outcome)).toEqual([
      "replayed",
      "replayed",
      "replayed",
      "replayed",
    ]);
    expect(await ledger()).toEqual(before);
  });
});
