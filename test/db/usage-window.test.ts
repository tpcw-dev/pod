import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { migrate } from "../../src/adapters/postgres/migrate.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { usageGates } from "../../src/core/plan/usage.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runLaunch } from "../../src/core/run/launch.ts";
import { usageSection } from "../../src/core/state/sections.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import {
  clearDb,
  dbUrl,
  describeDb,
  entriesAfter,
  journalThrough,
  openDb,
  resetDb,
} from "./helpers.ts";
import { morning, seedLaunch } from "./launch-fixture.ts";
import { crewValue } from "./seed.ts";

const provider = "runtime-a";
const minute = 60_000;
const limits = { floor_percent: 50, stale_minutes: 30 };

describeDb("usage observation windows", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  function observe(
    window: string,
    value: string,
    pace: string,
    at: Date,
    name = provider,
  ) {
    return conn.db.insertUsageObservation({
      provider: name,
      seat: null,
      window_start: at,
      window_end: at,
      value,
      coverage: "measured",
      observed_at: at,
      source: { kind: "usage record", window, pace },
    });
  }

  const gates = (at: Date, harness: string | null = null) =>
    usageGates(
      conn.db,
      [provider],
      harness === null
        ? []
        : [
            {
              event_id: 1,
              ts: at.toISOString(),
              actor: "person:human",
              harness,
              until: "2026-11-16",
              expires_at: new Date(at.getTime() + 60 * minute).toISOString(),
            },
          ],
      at,
    );

  test("a migrated database gives an existing row its window from source.window, and a no_source row none", async () => {
    await conn.sql`set client_min_messages = warning`;
    await conn.sql`drop schema if exists config, ledger, drizzle cascade`;
    await migrate(dbUrl(), journalThrough("0028_standup"));
    const at = morning.toISOString();
    await conn.sql`
      insert into ledger.usage_observation
        (provider, seat, window_start, window_end, value, coverage, observed_at, source)
      values
        (${provider}, null, ${at}, ${at}, 40, 'measured', ${at},
         ${JSON.stringify({ kind: "usage record", window: "long", pace: "ok" })}::jsonb),
        (${provider}, null, ${at}, ${at}, null, 'no_source', ${at},
         ${JSON.stringify({ kind: "none" })}::jsonb)`;
    expect(await migrate(dbUrl(), "db/migrations")).toMatchObject({
      kind: "ok",
      applied: entriesAfter("0028_standup"),
    });
    const rows = await conn.db.latestUsageWindows([provider]);
    expect(rows.map((row) => row.window).sort()).toEqual(["long", null]);
    await expect(
      conn.sql`update ledger.usage_observation set value = 1`,
    ).rejects.toThrow();
  });

  test("a long window that holds decides over a short window written last, in the plan gate and the launch hold", async () => {
    const long = await observe("long", "70", "avoid", morning);
    const short = await observe(
      "short",
      "10",
      "ok",
      new Date(morning.getTime() + minute),
    );
    expect(
      (await conn.db.latestUsageWindows([provider])).map((row) => row.id),
    ).toEqual([long.id, short.id]);
    expect(await gates(new Date(morning.getTime() + 2 * minute))).toEqual([
      {
        provider,
        state: "held",
        value: "70",
        pace: "avoid",
        window: "long",
        observation_id: long.id,
      },
    ]);
    await seedLaunch(conn, {
      crew: {
        seats: crewValue.seats.map((seat) => ({ ...seat, runtime: provider })),
      } as Json,
    });
    const refused = await runLaunch(
      conn.db,
      {
        orca: noCalls(),
        tracker: fakeTracker(),
        log: receiptLog(conn.db, "local"),
      },
      {
        story: "S-1",
        host: "local",
        provider: "linear",
        seats: {},
        subject: "manual",
        coordinator: "session-1",
        command: "pod run launch story:S-1",
        now: () => new Date(morning.getTime() + 2 * minute),
      },
    );
    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: "usage_hold",
        nextSteps: [`provider ${provider} window long reads 70, pace avoid`],
      },
    });
  });

  test("two known windows under the floor: the higher used value decides and the gate is available", async () => {
    await observe("long", "30", "ok", morning);
    const high = await observe(
      "short",
      "45",
      "ok",
      new Date(morning.getTime() - minute),
    );
    expect(await gates(morning)).toEqual([
      {
        provider,
        state: "available",
        value: "45",
        pace: "ok",
        window: "short",
        observation_id: high.id,
      },
    ]);
  });

  test("a stale window beside a fresh one: the fresh one decides; every window stale reads unknown", async () => {
    await observe(
      "long",
      "95",
      "avoid",
      new Date(morning.getTime() - 40 * minute),
    );
    const fresh = await observe("short", "20", "ok", morning);
    expect(await gates(morning)).toMatchObject([
      { state: "available", window: "short", observation_id: fresh.id },
    ]);
    const later = new Date(morning.getTime() + 40 * minute);
    expect(await gates(later)).toEqual([
      {
        provider,
        state: "unknown",
        value: null,
        pace: null,
        window: "short",
        observation_id: fresh.id,
      },
    ]);
  });

  test("a reset mark still reads reset", async () => {
    await observe("long", "100", "ok", morning);
    expect(await gates(morning, provider)).toMatchObject([
      { state: "reset", window: "long" },
    ]);
  });

  test("pod state shows the deciding window per provider", async () => {
    await observe("long", "80", "avoid", morning);
    await observe("short", "90", "ok", new Date(morning.getTime() + minute));
    await observe("short", "5", "ok", morning, "runtime-b");
    const section = await usageSection(
      {
        repo: conn.db,
        host: "local",
        docs: null,
        now: () => new Date(morning.getTime() + 2 * minute),
      },
      [provider, "runtime-b", "runtime-c"],
      limits,
    );
    expect(section.providers).toEqual([
      {
        provider,
        value: "80",
        coverage: "measured",
        window: "long",
        observed_at: morning.toISOString(),
      },
      {
        provider: "runtime-b",
        value: "5",
        coverage: "measured",
        window: "short",
        observed_at: morning.toISOString(),
      },
      {
        provider: "runtime-c",
        value: "unknown",
        coverage: "no_source",
        window: null,
        observed_at: null,
      },
    ]);
  });
});
