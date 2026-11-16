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
  type MetaDeps,
  type MetaOutcome,
} from "../../src/core/operate/meta.ts";
import type { MetaSeatRequest } from "../../src/core/operate/meta-digest.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import {
  fileSeat,
  learn,
  needsHuman,
  retroDueRun,
  retroLaunch,
  retroProcess,
  retroCrew,
} from "../db/meta-digest-seed.ts";
import { host, metaInput, metaTable, seedMeta } from "../db/meta-seed.ts";
import { replay } from "../db/run-fixture.ts";
import { activeRevision } from "../db/seed.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/meta-morning";

interface Call {
  at: string;
  note: string;
  slot?: string;
  lock?: "held";
  crash?: boolean;
  seed?: { retro_due?: boolean; learnings?: number; escalation?: "ruled" };
  readback?: "fail";
  expect: {
    outcome: MetaOutcome["outcome"] | "crashed";
    slots: string[];
    steps?: [MetaStepName, string][];
  };
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
const metaProcess = seedValue("specs/process/meta.yaml");
const [slot] = schedule["meta_slots"] as { steps: MetaStepName[] }[];

describeDb("meta-morning", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await seedMeta(conn, schedule["meta_slots"] as Json[], policy);
    await activeRevision(conn.db, "crew", "default", retroCrew);
    await activeRevision(conn.db, "process", "impl", retroProcess);
    await activeRevision(conn.db, "process", "meta", metaProcess);
  });

  const requests: MetaSeatRequest[] = [];
  const seat = fileSeat(requests);

  async function seeded(call: Call): Promise<OrcaPort | null> {
    const at = new Date(new Date(call.at).getTime() - 3600_000);
    let orca: OrcaPort | null = null;
    if (call.seed?.retro_due === true) {
      await retroDueRun(conn, at);
      orca = replay(conn, retroLaunch).orca;
    }
    for (let n = 1; n <= (call.seed?.learnings ?? 0); n += 1)
      await learn(conn, `${call.at} learning ${n}`, at);
    if (call.seed?.escalation === "ruled")
      await needsHuman(conn, "dec-1", at, "agreed");
    return orca;
  }
  afterAll(() => conn.close());

  async function meta(call: Call, orca: OrcaPort | null): Promise<MetaOutcome> {
    const input = metaInput(new Date(call.at), call.slot);
    const over: Partial<MetaDeps> = {
      seat,
      ...(orca === null ? {} : { orca }),
      ...(call.readback === "fail"
        ? { readback: () => Promise.resolve(false) }
        : {}),
    };
    const steps = metaTable(conn, over);
    const outcome =
      call.lock === "held"
        ? await conn.sql.begin(async (held) => {
            await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}:meta`}))`;
            return runMeta(conn.db, input, steps);
          })
        : await runMeta(conn.db, input, steps);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome;
  }

  test("mornings from the seeds: not due, ran, coalesced, a killed slot rerun, a forced run, and a retro, digest, and escalation morning with a failed readback", async () => {
    let crashed: string[] | null = null;
    for (const call of day) {
      if (call.crash === true) {
        const steps = await runMetaSteps(
          conn.db,
          metaInput(new Date(call.at)),
          slot?.steps ?? [],
          metaTable(conn, { seat }),
        );
        crashed = steps.map((each) => each.op_key);
        expect(call.expect.outcome, call.note).toBe("crashed");
        continue;
      }
      const outcome = await meta(call, await seeded(call));
      expect(outcome.outcome, call.note).toBe(call.expect.outcome);
      expect(
        outcome.slots.map((each) => each.slot),
        call.note,
      ).toEqual(call.expect.slots);
      for (const each of outcome.slots)
        expect(
          each.steps.map((step) => [step.step, step.result]),
          call.note,
        ).toEqual(
          call.expect.steps ?? [
            ["retro", "ok"],
            ["digest", "ok"],
          ],
        );
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
    const ticks = await conn.sql<
      { payload: { steps: { step: string; op_key: string; detail: Json }[] } }[]
    >`
      select payload from ledger.event
      where type = 'tick' and payload->>'agenda' = 'meta' order by id desc limit 2`;
    const [rerun, failed] = ticks.map((tick) =>
      tick.payload.steps.find((step) => step.step === "digest"),
    );
    expect(rerun?.op_key).toBe(failed?.op_key);
    expect(failed?.detail).toMatchObject({ code: "readback_failed" });
    expect(rerun?.detail).toMatchObject({ day: "2026-11-17", queued: 1 });
    const [retro] = ticks.map((tick) =>
      tick.payload.steps.find((step) => step.step === "retro"),
    );
    expect(retro?.detail).toMatchObject({
      runs: [
        { run_id: "run_1", state: "dispatched", dispatch_id: "ctx_retro" },
      ],
    });
    const escalation = requests.find((request) =>
      request.packet.includes("decision dec-1 agreed"),
    );
    expect(escalation).toBeDefined();
    const digests = await conn.sql<{ op_key: string; meta: boolean }[]>`
      select op_key, payload ? 'meta' as meta from ledger.event
      where type = 'digest' and payload->>'day' = '2026-11-17' order by id`;
    expect(digests).toEqual([
      { op_key: "digest:global:2026-11-17", meta: false },
      { op_key: rerun?.op_key, meta: true },
    ]);
    const [proposals] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.digest_proposal`;
    expect(proposals?.n).toBe(4);
  });
});
