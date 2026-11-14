import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { UsageObservation } from "../../src/core/domain/ledger.ts";
import { parseUsage } from "../../src/core/domain/usage.ts";
import { pace, readHeadroom } from "../../src/core/usage/pace.ts";
import { recordUsage } from "../../src/core/usage/record.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { seatRun } from "./identity-fixture.ts";

const runtime = "example-runtime";
const limits = { floor_percent: 50, stale_minutes: 30 };
const now = new Date("2026-11-10T12:00:00Z");
const iso = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ${column}`;
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

function unit(over: Record<string, unknown> = {}) {
  return {
    type: "unit",
    runtime,
    session_id: "s-1",
    key: "u-1",
    at: "2026-11-10T10:00:00Z",
    model: "example-model",
    cwd: null,
    input: 100,
    cached_input: 40,
    cache_write: 10,
    output: 20,
    reasoning: 5,
    calls: 1,
    ...over,
  };
}

function window(over: Record<string, unknown> = {}) {
  return {
    type: "window",
    runtime,
    window: "example-window",
    used_percent: 30,
    window_minutes: 300,
    resets_at: "2026-11-10T14:00:00Z",
    observed_at: "2026-11-10T11:00:00Z",
    ...over,
  };
}

function lines(...rows: object[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function usage(...rows: object[]) {
  const parsed = parseUsage(lines(...rows));
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.input;
}

describe("usage record format", () => {
  test("a unit row with nulls and a window row parse, and blank lines are skipped", () => {
    const parsed = parseUsage(
      `${lines(unit({ model: null, cwd: null, reasoning: null, calls: null }))}\n\n${lines(window({ used_percent: null }))}\n`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.units[0]).toMatchObject({
      model: null,
      reasoning: null,
      calls: null,
      at: new Date("2026-11-10T10:00:00Z"),
    });
    expect(parsed.input.windows[0]?.used_percent).toBeNull();
  });

  test.each([
    ["not JSON", "not json", "line 1: not a JSON object"],
    [
      "a partial line",
      '{"type":"unit","runtime":"x"',
      "line 1: not a JSON object",
    ],
    ["an unknown type", lines({ type: "example" }), "line 1 type"],
    [
      "an extra key",
      lines(unit({ text: "hello" })),
      "line 1 text: unknown key",
    ],
    ["a missing field", lines({ ...unit(), calls: undefined }), "line 1 calls"],
    ["a negative count", lines(unit({ input: -1 })), "line 1 input"],
    ["a fractional count", lines(unit({ output: 1.5 })), "line 1 output"],
    [
      "a timestamp with no offset",
      lines(unit({ at: "2026-11-10T10:00:00" })),
      "line 1 at",
    ],
    ["a relative cwd", lines(unit({ cwd: "work/a" })), "line 1 cwd"],
    [
      "a zero window length",
      lines(window({ window_minutes: 0 })),
      "line 1 window_minutes",
    ],
  ])("%s is refused with its line", (_name, text, issue) => {
    const parsed = parseUsage(`${lines(unit())}\n${text}`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("\n")).toContain(
      issue.replace("line 1", "line 2"),
    );
  });
});

describe("pace", () => {
  const fiveHours = { window_minutes: 300, resets_at: minutes(150) };
  const week = { window_minutes: 7 * 24 * 60, resets_at: minutes(12 * 60) };

  test("halfway through a window, use above the floor and ahead of the clock is avoid", () => {
    expect(pace({ ...fiveHours, used_percent: 51 }, now, 50)).toBe("avoid");
  });

  test("use at the floor is ok even when ahead of the clock", () => {
    const early = { window_minutes: 300, resets_at: minutes(240) };
    expect(pace({ ...early, used_percent: 50 }, now, 50)).toBe("ok");
    expect(pace({ ...early, used_percent: 50.5 }, now, 50)).toBe("avoid");
  });

  test("use above the floor but behind the clock is ok", () => {
    expect(
      pace(
        { window_minutes: 300, resets_at: minutes(60), used_percent: 70 },
        now,
        50,
      ),
    ).toBe("ok");
  });

  test("the last day of a week-long window is spend below 100 and ok at 100", () => {
    expect(pace({ ...week, used_percent: 90 }, now, 50)).toBe("spend");
    expect(pace({ ...week, used_percent: 100 }, now, 50)).toBe("ok");
  });

  test("a window past its reset is ok", () => {
    expect(
      pace(
        { window_minutes: 300, resets_at: minutes(-1), used_percent: 99 },
        now,
        50,
      ),
    ).toBe("ok");
  });
});

describe("headroom read", () => {
  function observation(over: Partial<UsageObservation>): UsageObservation {
    return {
      id: 1,
      provider: runtime,
      seat: null,
      window_start: minutes(-300),
      window_end: minutes(60),
      value: "42",
      coverage: "measured",
      observed_at: minutes(-30),
      source: { kind: "usage record", window: "example-window", pace: "avoid" },
      ...over,
    };
  }

  test("an observation at stale_minutes reads with its value and pace", () => {
    expect(readHeadroom(observation({}), limits, now)).toEqual({
      value: "42",
      pace: "avoid",
    });
  });

  test("an observation older than stale_minutes reads as unknown", () => {
    expect(
      readHeadroom(observation({ observed_at: minutes(-31) }), limits, now),
    ).toBe("unknown");
  });

  test("no row, a no_source row, and a null value read as unknown", () => {
    expect(readHeadroom(undefined, limits, now)).toBe("unknown");
    expect(
      readHeadroom(
        observation({ coverage: "no_source", value: null }),
        limits,
        now,
      ),
    ).toBe("unknown");
    expect(
      readHeadroom(
        observation({ coverage: "partial", value: null }),
        limits,
        now,
      ),
    ).toBe("unknown");
  });
});

describeDb("pod usage record", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function placeDispatch(input: {
    runId: string;
    dispatchId: string;
    host: string;
    worktree?: string;
    transcript?: { harness: string; session_id: string };
  }) {
    const opKey = `launch:${input.dispatchId}`;
    await conn.db.insertOperation({
      op_key: opKey,
      intent: "dispatch",
      owner_generation: 1,
      at: now,
    });
    await conn.db.moveOperation(opKey, "done", null, now);
    const requested: Json =
      input.worktree === undefined
        ? {}
        : { worktree: `id:example-repo::${input.worktree}` };
    await conn.db.insertDispatch({
      dispatch_id: input.dispatchId,
      task_id: null,
      decision_id: null,
      run_id: input.runId,
      seat: "example-seat",
      role: "decider",
      requested_launch: requested,
      effective_launch:
        input.transcript === undefined
          ? null
          : { transcript: input.transcript },
      model_attribution: "unknown",
      retry_of: null,
      op_key: opKey,
      settlement: "open",
      terminal_handle: null,
      created_at: now,
      settled_at: null,
      activity: "running",
      manifest_id: null,
      prompt_bytes: null,
    });
    await conn.db.appendEvent({
      type: "start",
      ts: now,
      host: input.host,
      run_id: input.runId,
      task_id: null,
      dispatch_id: input.dispatchId,
      op_key: opKey,
      payload: {},
      source: { kind: "command", verb: "dispatch" },
    });
  }

  function record(text: ReturnType<typeof usage>, host = "host-a") {
    return recordUsage(conn.db, { usage: text, limits, host, now: () => now });
  }

  async function records() {
    return conn.sql<
      {
        session_id: string;
        model: string | null;
        input: string | null;
        cached_input: string | null;
        cache_write: string | null;
        output: string | null;
        reasoning: string | null;
        calls: number | null;
        first_at: string;
        through: string;
        dispatch_id: string | null;
        run_id: string | null;
        attribution: string;
        coverage: string;
      }[]
    >`select session_id, model, input, cached_input, cache_write, output,
        reasoning, calls, ${conn.sql.unsafe(iso("first_at"))}, ${conn.sql.unsafe(iso("through"))}, dispatch_id, run_id, attribution, coverage
      from ledger.usage_record order by session_id, through, model nulls first`;
  }

  test("a session sums per model, null only when no unit knows a field, partial when any unit lacks one", async () => {
    const result = await record(
      usage(
        unit({ key: "u-1" }),
        unit({ key: "u-2", at: "2026-11-10T10:05:00Z", reasoning: null }),
        unit({
          key: "u-3",
          at: "2026-11-10T10:10:00Z",
          model: "example-model-b",
          reasoning: null,
          calls: null,
        }),
        unit({ key: "u-1", input: 999 }),
      ),
    );
    expect(result).toMatchObject({ units: 4, duplicates: 1 });
    expect(result.sessions).toEqual([
      {
        runtime,
        session_id: "s-1",
        attribution: "unattributed",
        dispatch_id: null,
        run_id: null,
        first_at: "2026-11-10T10:00:00.000Z",
        through: "2026-11-10T10:10:00.000Z",
        rows: 2,
        outcome: "written",
      },
    ]);
    expect(await records()).toEqual([
      expect.objectContaining({
        model: "example-model",
        input: "200",
        cached_input: "80",
        reasoning: "5",
        calls: 2,
        coverage: "partial",
        first_at: "2026-11-10T10:00:00Z",
        through: "2026-11-10T10:10:00Z",
      }),
      expect.objectContaining({
        model: "example-model-b",
        input: "100",
        reasoning: null,
        calls: null,
        coverage: "partial",
      }),
    ]);
  });

  test("a session matching a Dispatch's transcript locator is attributed to that Dispatch", async () => {
    await seatRun(conn.db, "run_1");
    await placeDispatch({
      runId: "run_1",
      dispatchId: "d_loc",
      host: "host-b",
      transcript: { harness: runtime, session_id: "s-1" },
    });
    const result = await record(usage(unit({ cwd: "/elsewhere" })));
    expect(result.sessions[0]).toMatchObject({
      attribution: "locator",
      dispatch_id: "d_loc",
      run_id: null,
    });
    expect((await records())[0]).toMatchObject({
      attribution: "locator",
      dispatch_id: "d_loc",
      run_id: null,
      coverage: "measured",
    });
  });

  test("a locator on another runtime does not match", async () => {
    await seatRun(conn.db, "run_1");
    await placeDispatch({
      runId: "run_1",
      dispatchId: "d_loc",
      host: "host-a",
      transcript: { harness: "example-other", session_id: "s-1" },
    });
    const result = await record(usage(unit()));
    expect(result.sessions[0]?.attribution).toBe("unattributed");
  });

  test("a cwd under a Run's worktree on this host is attributed to the Run; a sibling path and another host's path are not", async () => {
    await seatRun(conn.db, "run_a");
    await seatRun(conn.db, "run_n");
    await seatRun(conn.db, "run_b");
    await placeDispatch({
      runId: "run_a",
      dispatchId: "d_a",
      host: "host-a",
      worktree: "/work/a",
    });
    await placeDispatch({
      runId: "run_n",
      dispatchId: "d_n",
      host: "host-a",
      worktree: "/work/a/nested",
    });
    await placeDispatch({
      runId: "run_b",
      dispatchId: "d_b",
      host: "host-b",
      worktree: "/work/b",
    });
    const result = await record(
      usage(
        unit({ session_id: "s-a", key: "a", cwd: "/work/a/src" }),
        unit({ session_id: "s-n", key: "n", cwd: "/work/a/nested/deep" }),
        unit({ session_id: "s-sib", key: "sib", cwd: "/work/a-b" }),
        unit({ session_id: "s-b", key: "b", cwd: "/work/b" }),
        unit({ session_id: "s-none", key: "none", cwd: null }),
      ),
    );
    expect(
      result.sessions.map((row) => [
        row.session_id,
        row.attribution,
        row.run_id,
        row.dispatch_id,
      ]),
    ).toEqual([
      ["s-a", "path", "run_a", null],
      ["s-n", "path", "run_n", null],
      ["s-sib", "unattributed", null, null],
      ["s-b", "unattributed", null, null],
      ["s-none", "unattributed", null, null],
    ]);
  });

  test("an unattributed row stays unattributed when a matching Dispatch appears later", async () => {
    await record(usage(unit()));
    await seatRun(conn.db, "run_1");
    await placeDispatch({
      runId: "run_1",
      dispatchId: "d_late",
      host: "host-a",
      transcript: { harness: runtime, session_id: "s-1" },
    });
    expect((await records()).map((row) => row.attribution)).toEqual([
      "unattributed",
    ]);
  });

  test("the newest through is the watermark: a later ingest writes only the new span", async () => {
    await record(
      usage(
        unit({ key: "u-1" }),
        unit({ key: "u-2", at: "2026-11-10T10:05:00Z" }),
      ),
    );
    const second = await record(
      usage(
        unit({ key: "u-1" }),
        unit({ key: "u-2", at: "2026-11-10T10:05:00Z" }),
        unit({ key: "u-3", at: "2026-11-10T10:20:00Z", input: 7 }),
      ),
    );
    expect(second.sessions[0]).toMatchObject({
      first_at: "2026-11-10T10:20:00.000Z",
      through: "2026-11-10T10:20:00.000Z",
      rows: 1,
      outcome: "written",
    });
    expect((await records()).map((row) => [row.input, row.through])).toEqual([
      ["200", "2026-11-10T10:05:00Z"],
      ["7", "2026-11-10T10:20:00Z"],
    ]);
  });

  test("the same output sent twice writes once", async () => {
    const input = usage(unit(), window());
    await record(input);
    const before = await records();
    const again = await record(input);
    expect(again.sessions[0]?.outcome).toBe("nothing_new");
    expect(again.windows[0]?.outcome).toBe("replayed");
    expect(await records()).toEqual(before);
    const [counts] = await conn.sql<{ observations: number; ops: number }[]>`
      select (select count(*)::int from ledger.usage_observation) as observations,
        (select count(*)::int from ledger.operation where intent = 'usage') as ops`;
    expect(counts).toEqual({ observations: 1, ops: 2 });
  });

  test("a window row writes a measured observation with its pace in source", async () => {
    const result = await record(
      usage(
        window({ used_percent: 62.5 }),
        window({
          window: "example-week",
          used_percent: null,
          observed_at: "2026-11-10T11:01:00Z",
        }),
      ),
    );
    expect(
      result.windows.map((row) => [row.window, row.pace, row.outcome]),
    ).toEqual([
      ["example-window", "avoid", "written"],
      ["example-week", null, "written"],
    ]);
    const rows = await conn.sql<
      {
        value: string | null;
        coverage: string;
        window_start: string;
        window_end: string;
        source: unknown;
        seat: string | null;
      }[]
    >`select value, coverage, ${conn.sql.unsafe(iso("window_start"))}, ${conn.sql.unsafe(iso("window_end"))}, source, seat
      from ledger.usage_observation order by id`;
    expect(rows).toEqual([
      {
        value: "62.5",
        coverage: "measured",
        window_start: "2026-11-10T09:00:00Z",
        window_end: "2026-11-10T14:00:00Z",
        source: {
          kind: "usage record",
          window: "example-window",
          pace: "avoid",
        },
        seat: null,
      },
      {
        value: null,
        coverage: "partial",
        window_start: "2026-11-10T09:00:00Z",
        window_end: "2026-11-10T14:00:00Z",
        source: { kind: "usage record", window: "example-week", pace: null },
        seat: null,
      },
    ]);
  });

  test("the policy floor sets the pace", async () => {
    const result = await recordUsage(conn.db, {
      usage: usage(window({ used_percent: 62.5 })),
      limits: { floor_percent: 70, stale_minutes: 30 },
      host: "host-a",
      now: () => now,
    });
    expect(result.windows[0]?.pace).toBe("ok");
  });

  test("usage_record rows refuse update and delete", async () => {
    await record(usage(unit()));
    await expect(
      conn.sql`update ledger.usage_record set calls = 9`,
    ).rejects.toThrow(/not allowed/);
    await expect(conn.sql`delete from ledger.usage_record`).rejects.toThrow(
      /not allowed/,
    );
  });

  test("pod usage record FILE writes rows, and a malformed FILE writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-usage-record-"));
    const good = join(dir, "good.jsonl");
    writeFileSync(good, `${lines(unit(), window())}\n`);
    const ok = runCli(["usage", "record", good]);
    expect(ok.status).toBe(0);
    expect(ok.json.result).toMatchObject({
      units: 1,
      sessions: [
        { session_id: "s-1", attribution: "unattributed", outcome: "written" },
      ],
      windows: [{ window: "example-window", outcome: "written" }],
    });
    const bad = join(dir, "bad.jsonl");
    writeFileSync(
      bad,
      `${lines(unit({ key: "u-9", session_id: "s-9" }))}\n{"type":"unit"\n`,
    );
    const refused = runCli(["usage", "record", bad]);
    expect(refused.status).toBe(2);
    expect(refused.json.error?.code).toBe("schema_invalid");
    expect(refused.json.error?.nextSteps).toEqual([
      "line 2: not a JSON object",
    ]);
  });
});
