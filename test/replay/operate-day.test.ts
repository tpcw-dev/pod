import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Kind } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { TriggerSource } from "../../src/core/domain/tick.ts";
import {
  dryRunTick,
  runSteps,
  runTick,
  type TickOutcome,
} from "../../src/core/operate/tick.ts";
import {
  recordTriggers,
  type TriggerInput,
} from "../../src/core/operate/triggers.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { hostValue } from "../db/seed.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/operate-day";
const host = "local";

interface Call {
  at: string;
  note: string;
  triggers: string[];
  lock?: "held";
  crash?: boolean;
  expect: { outcome: TickOutcome["outcome"] | "crashed"; consumed: string[] };
}

const day = readFileSync(join(dir, "day.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Call);

function trigger(text: string): TriggerInput {
  const [source = "", ...id] = text.split(":");
  return { source: TriggerSource.parse(source), trigger_id: id.join(":") };
}

describeDb("operate-day", () => {
  let conn: Connection;
  const triggerIds = new Map<string, number>();

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await activate("host", host, hostValue(2));
    await activate("schedule", "default", {
      tick_minutes: 15,
      hold_minutes: 60,
    });
  });
  afterAll(() => conn.close());

  async function activate(kind: Kind, name: string, value: Json) {
    const revision = await storeRevision(conn.db, {
      ...envelope(kind, name, value),
      scope: "host",
      scope_ref: host,
    });
    await conn.db.activate({
      scope: "host",
      scope_ref: host,
      kind,
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date(day[0]?.at ?? 0),
    });
  }

  function input(call: Call) {
    return {
      host,
      writer: host,
      actor: "person:human",
      now: new Date(call.at),
      triggers: call.triggers.map(trigger),
    };
  }

  async function tick(call: Call): Promise<TickOutcome> {
    const outcome =
      call.lock === "held"
        ? await conn.sql.begin(async (held) => {
            await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}`}))`;
            return runTick(conn.db, input(call));
          })
        : await runTick(conn.db, input(call));
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    for (const each of outcome.recorded)
      triggerIds.set(`${each.source}:${each.trigger_id}`, each.event_id);
    return outcome;
  }

  test("a day of polls and triggers, one coalesced pair, and one crash and re-run", async () => {
    let crashed: { tick_id: string | null; op_keys: string[] } | null = null;
    const ticks: string[] = [];
    for (const call of day) {
      if (call.crash === true) {
        const planned = await dryRunTick(conn.db, input(call));
        if (!planned.ok) throw new Error(planned.refusal.message);
        for (const each of await recordTriggers(conn.db, input(call)))
          triggerIds.set(`${each.source}:${each.trigger_id}`, each.event_id);
        const steps = await runSteps(conn.db, input(call));
        crashed = {
          tick_id: planned.tick_id,
          op_keys: steps.steps.map((each) => each.op_key),
        };
        expect(call.expect.outcome, call.note).toBe("crashed");
        continue;
      }
      const outcome = await tick(call);
      expect(outcome.outcome, call.note).toBe(call.expect.outcome);
      expect(outcome.consumed, call.note).toEqual(
        call.expect.consumed.map((text) => triggerIds.get(text)),
      );
      if (outcome.tick_id !== null) ticks.push(outcome.tick_id);
      if (crashed !== null && outcome.outcome === "ran") {
        expect(outcome.tick_id, call.note).toBe(crashed.tick_id);
        expect(
          outcome.steps.map((each) => each.op_key),
          call.note,
        ).toEqual(crashed.op_keys);
        crashed = null;
      }
    }
    expect(crashed).toBeNull();
    expect(new Set(ticks).size).toBe(ticks.length);
    const [row] = await conn.sql<{ ticks: number; triggers: number }[]>`
      select count(*) filter (where type = 'tick')::int as ticks,
        count(*) filter (where type = 'trigger')::int as triggers
      from ledger.event`;
    expect(row).toEqual({
      ticks: day.filter((call) => call.expect.outcome === "ran").length,
      triggers: 4,
    });
  });
});
