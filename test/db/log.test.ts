import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
import type { Event, NewEvent } from "../../src/core/domain/ledger.ts";
import { groupLog, logHeadings } from "../../src/core/operate/log.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import {
  clearDb,
  dbUrl,
  describeDb,
  openDb,
  podHome,
  resetDb,
  runCli,
} from "./helpers.ts";
import { hostValue } from "./seed.ts";

const zone = "America/Los_Angeles";

function tick(host: string, extra: Partial<Record<string, Json>> = {}): Json {
  return {
    host,
    tick_id: `tick:${host}`,
    actor: "person:human",
    schedule_revision: "rev",
    plan_event: null,
    overrides: [],
    triggers: [],
    steps: [
      { step: "read_plan", op_key: "k1", result: "ok", detail: null },
      {
        step: "observe",
        op_key: "k2",
        result: "failed",
        detail: { error: "boom" },
      },
      { step: "launch", op_key: "k3", result: "skipped", detail: null },
      { step: "attention", op_key: "k4", result: "not_built", detail: null },
    ],
    launch: [],
    refuse: [{ key: "S-3", reason: "quota" }],
    ...extra,
  };
}

function row(
  type: NewEvent["type"],
  ts: string,
  payload: Json,
  extra: Partial<NewEvent> = {},
): NewEvent {
  return {
    type,
    ts: new Date(ts),
    host: "local",
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload,
    source: { kind: "command", verb: "test" },
    ...extra,
  };
}

const day = [
  row(
    "start",
    "2026-11-15T07:59:59.000Z",
    { seat: "early", role: "lead" },
    {
      run_id: "run-1",
    },
  ),
  row(
    "start",
    "2026-11-15T08:00:00.000Z",
    { seat: "lead", role: "lead" },
    {
      run_id: "run-2",
    },
  ),
  row(
    "close",
    "2026-11-15T09:00:00.000Z",
    { story: "S-2" },
    {
      run_id: "run-2",
    },
  ),
  row("decision", "2026-11-15T10:00:00.000Z", {
    decision_id: "dec_1",
    outcome: "answered",
    reason: "answered",
  }),
  row("plan", "2026-11-15T10:30:00.000Z", { kind: "published", host: "local" }),
  row("plan", "2026-11-15T10:40:00.000Z", {
    kind: "hold",
    host: "local",
    key: "S-9",
    reason: "waits",
  }),
  row("escalate", "2026-11-15T11:00:00.000Z", {
    story: "S-2",
    kind: "p0",
    text: "a defect\nafter merge",
  }),
  row(
    "hold",
    "2026-11-15T12:00:00.000Z",
    { reason: "launch_unknown" },
    {
      run_id: "run-2",
    },
  ),
  row("tick", "2026-11-15T13:00:00.000Z", tick("local")),
  row("tick", "2026-11-15T13:05:00.000Z", tick("other")),
  row("delivery", "2026-11-15T14:00:00.000Z", { kind: "report" }),
  row("ignored", "2026-11-15T15:00:00.000Z", { reason: "close_report_sender" }),
  row("unknown_launch", "2026-11-15T16:00:00.000Z", { seat: "ghost" }),
  row("cancel", "2026-11-15T17:00:00.000Z", "not an object"),
  row("tick", "2026-11-15T18:00:00.000Z", { host: "local", steps: "bad" }),
  row("hold", "2026-11-16T07:59:59.000Z", { reason: "last instant" }),
  row("hold", "2026-11-16T08:00:00.000Z", { reason: "next day" }),
];

const expectedText = `log for 2026-11-15 (America/Los_Angeles), host local
## Launched
- 2026-11-15T08:00:00.000Z #N start run run-2 seat=lead role=lead
## Closed
- 2026-11-15T09:00:00.000Z #N close run run-2 story=S-2
## Groomed
none
## Decided
- 2026-11-15T10:00:00.000Z #N decision outcome=answered reason=answered decision_id=dec_1
- 2026-11-15T10:30:00.000Z #N plan kind=published
## Needs a person
- 2026-11-15T11:00:00.000Z #N escalate story=S-2 kind=p0 text=a defect after merge
## Held
- 2026-11-15T10:40:00.000Z #N plan kind=hold key=S-9 reason=waits
- 2026-11-15T12:00:00.000Z #N hold run run-2 reason=launch_unknown
- 2026-11-16T07:59:59.000Z #N hold reason=last instant
## Skipped
- 2026-11-15T13:00:00.000Z #N tick step launch skipped
- 2026-11-15T13:00:00.000Z #N tick refuse {"key":"S-3","reason":"quota"}
- 2026-11-15T15:00:00.000Z #N ignored reason=close_report_sender
## Errors
- 2026-11-15T13:00:00.000Z #N tick step observe failed {"error":"boom"}
- 2026-11-15T16:00:00.000Z #N unknown_launch seat=ghost
- 2026-11-15T17:00:00.000Z #N cancel payload unreadable
- 2026-11-15T18:00:00.000Z #N tick payload unreadable`;

describe("groupLog", () => {
  const events: Event[] = day.map((each, index) => ({
    ...each,
    id: index + 1,
  }));

  test("prints the eight headings in order, each line naming its event", () => {
    const groups = groupLog(events, "local");
    expect(groups.map((group) => group.heading)).toEqual([...logHeadings]);
    expect(logHeadings).toEqual([
      "Launched",
      "Closed",
      "Groomed",
      "Decided",
      "Needs a person",
      "Held",
      "Skipped",
      "Errors",
    ]);
    const closed = groups.find((group) => group.heading === "Closed");
    expect(closed?.lines).toEqual([
      {
        event_id: 3,
        type: "close",
        ts: new Date("2026-11-15T09:00:00.000Z"),
        run_id: "run-2",
        text: "close run run-2 story=S-2",
      },
    ]);
    expect(groups.find((group) => group.heading === "Groomed")?.lines).toEqual(
      [],
    );
  });

  test("a payload host decides the host, else the event's host column", () => {
    const other = groupLog(events, "other").flatMap((group) => group.lines);
    expect(other.map((line) => line.event_id)).toEqual([10, 10, 10]);
  });

  test("a meta tick lists its failed and timed out steps under Errors", () => {
    const meta: Event = {
      ...events[8]!,
      payload: {
        agenda: "meta",
        host: "local",
        tick_id: "tick:meta",
        actor: "person:human",
        schedule_revision: "rev",
        slot: "morning",
        steps: [
          { step: "retro", op_key: "m1", result: "failed", detail: null },
          { step: "digest", op_key: "m2", result: "timed_out", detail: null },
          { step: "digest", op_key: "m3", result: "ok", detail: null },
        ],
      },
    };
    const groups = groupLog([meta], "local");
    expect(
      groups.flatMap((group) =>
        group.lines.map((line) => `${group.heading}: ${line.text}`),
      ),
    ).toEqual([
      "Errors: tick step retro failed",
      "Errors: tick step digest timed_out",
    ]);
  });

  test("a host attention drain is a Held line with no Run phrase", () => {
    const drain: Event = {
      ...events[0]!,
      ...row("drain", "2026-11-15T12:00:00.000Z", {
        ended: false,
        op_key: "drain:host",
        scope: "host",
        host: "local",
        cause: "pause_at",
      }),
      id: 99,
    };
    const groups = groupLog([drain], "local");
    expect(
      groups.flatMap((group) =>
        group.lines.map((line) => `${group.heading}: ${line.text}`),
      ),
    ).toEqual(["Held: drain"]);
  });

  test("a long text is cut to 160 characters", () => {
    const [line] = groupLog(
      [{ ...events[6]!, payload: { text: "x".repeat(400) } }],
      "local",
    ).flatMap((group) => group.lines);
    expect(line?.text).toHaveLength(160);
  });
});

describeDb("pod log", () => {
  let conn: Connection;
  const out = mkdtempSync(join(tmpdir(), "pod-log-"));

  async function activeHost(timezone: string): Promise<void> {
    const revision = await storeRevision(conn.db, {
      ...envelope("host", "local", { ...(hostValue(2) as object), timezone }),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "host",
      name: "local",
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date("2026-11-01T00:00:00.000Z"),
    });
    if (!activated.ok) throw new Error("host not activated");
  }

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await clearDb(conn);
    for (const each of day) await conn.db.appendEvent(each);
  });
  afterAll(() => conn.close());

  test("renders one local day of the ledger under the eight headings", async () => {
    await activeHost(zone);
    const result = runCli(["log", "--date", "2026-11-15", "--json"]);
    expect(result.status).toBe(0);
    expect(result.json.result).toMatchObject({
      host: "local",
      day: "2026-11-15",
      time_zone: zone,
      since: "2026-11-15T08:00:00.000Z",
      until: "2026-11-16T08:00:00.000Z",
    });
    const text = spawnSync(
      "node_modules/.bin/tsx",
      ["src/cli/index.ts", "log", "--date", "2026-11-15"],
      {
        encoding: "utf8",
        env: { ...process.env, POD_DB_URL: dbUrl(), POD_HOME: podHome },
      },
    );
    expect(text.stdout.trim().replaceAll(/#\d+/g, "#N")).toBe(expectedText);
  });

  test("the day before reads the event one second before local midnight", async () => {
    await activeHost(zone);
    const result = runCli(["log", "--date", "2026-11-14", "--json"]);
    const headings = result.json.result?.["headings"] as {
      heading: string;
      lines: { text: string }[];
    }[];
    expect(
      headings.flatMap((group) => group.lines.map((line) => line.text)),
    ).toEqual(["start run run-1 seat=early role=lead"]);
  });

  test("--host reads another host's events", async () => {
    await activeHost(zone);
    const result = runCli([
      "log",
      "--date",
      "2026-11-15",
      "--host",
      "other",
      "--json",
    ]);
    const headings = result.json.result?.["headings"] as {
      lines: { text: string }[];
    }[];
    expect(headings.flatMap((group) => group.lines).length).toBe(3);
  });

  test("a malformed or impossible --date is usage", () => {
    for (const date of ["2026-02-30", "2026-13-40", "yesterday"]) {
      const result = runCli(["log", "--date", date, "--json"]);
      expect(result.status, date).toBe(2);
      expect(result.json.error?.message).toBe("usage: log");
    }
  });

  test("a host timezone that is not a time zone reads UTC and says so", async () => {
    await activeHost("Mars/Base");
    const result = runCli(["log", "--date", "2026-11-15", "--json"]);
    expect(result.json.result).toMatchObject({
      time_zone: "UTC",
      since: "2026-11-15T00:00:00.000Z",
      nextSteps: [
        "the host Revision's timezone Mars/Base is not a time zone; log days read UTC",
      ],
    });
  });

  test("--html writes one table per heading", async () => {
    await activeHost(zone);
    const file = join(out, "log.html");
    expect(
      runCli(["log", "--date", "2026-11-15", "--html", file, "--json"]).status,
    ).toBe(0);
    const html = readFileSync(file, "utf8");
    for (const slug of [
      "launched",
      "closed",
      "groomed",
      "decided",
      "needs-a-person",
      "held",
      "skipped",
      "errors",
    ])
      expect(html).toContain(`<table id="log-${slug}">`);
    expect(html).toMatch(
      /<table id="log-groomed">[\s\S]*?none[\s\S]*?<\/table>/,
    );
  });
});
