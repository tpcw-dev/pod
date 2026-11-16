import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { MetaStepName } from "../../src/core/domain/tick.ts";
import {
  runMeta,
  runMetaSteps,
  type MetaOutcome,
} from "../../src/core/operate/meta.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { host, metaInput, seedMeta } from "../db/meta-seed.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/meta-morning";

interface Call {
  at: string;
  note: string;
  slot?: string;
  lock?: "held";
  crash?: boolean;
  expect: { outcome: MetaOutcome["outcome"] | "crashed"; slots: string[] };
}

const day = readFileSync(join(dir, "day.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Call);

function seedValue(path: string): Record<string, Json> {
  return (parse(readFileSync(path, "utf8")) as { value: Record<string, Json> })
    .value;
}

const schedule = seedValue("specs/schedule/default.yaml");
const policy = seedValue("specs/policy/default.yaml");
const [slot] = schedule["meta_slots"] as { steps: MetaStepName[] }[];

describeDb("meta-morning", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await seedMeta(conn, schedule["meta_slots"] as Json[], policy);
  });
  afterAll(() => conn.close());

  async function meta(call: Call): Promise<MetaOutcome> {
    const input = metaInput(new Date(call.at), call.slot);
    const outcome =
      call.lock === "held"
        ? await conn.sql.begin(async (held) => {
            await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}:meta`}))`;
            return runMeta(conn.db, input);
          })
        : await runMeta(conn.db, input);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome;
  }

  test("a morning slot from the seeds: not due, ran, coalesced, a killed slot rerun, and a forced run", async () => {
    let crashed: string[] | null = null;
    for (const call of day) {
      if (call.crash === true) {
        const steps = await runMetaSteps(
          conn.db,
          metaInput(new Date(call.at)),
          slot?.steps ?? [],
        );
        crashed = steps.map((each) => each.op_key);
        expect(call.expect.outcome, call.note).toBe("crashed");
        continue;
      }
      const outcome = await meta(call);
      expect(outcome.outcome, call.note).toBe(call.expect.outcome);
      expect(
        outcome.slots.map((each) => each.slot),
        call.note,
      ).toEqual(call.expect.slots);
      for (const each of outcome.slots)
        expect(
          each.steps.map((step) => [step.step, step.result]),
          call.note,
        ).toEqual([
          ["retro", "not_built"],
          ["digest", "not_built"],
        ]);
      if (crashed !== null && outcome.outcome === "ran") {
        expect(
          outcome.slots[0]?.steps.map((each) => each.op_key),
          call.note,
        ).toEqual(crashed);
        crashed = null;
      }
    }
    expect(crashed).toBeNull();
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event
      where type = 'tick' and payload->>'agenda' = 'meta'`;
    expect(row?.n).toBe(
      day.filter((call) => call.expect.outcome === "ran").length,
    );
  });
});
