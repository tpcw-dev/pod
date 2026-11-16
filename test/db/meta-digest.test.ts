import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { prepareDigest } from "../../src/core/digest/prepare.ts";
import type { MetaStepRecord } from "../../src/core/domain/tick.ts";
import {
  runMeta,
  runMetaSteps,
  type MetaClock,
  type MetaDeps,
} from "../../src/core/operate/meta.ts";
import type {
  MetaSeat,
  MetaSeatRequest,
} from "../../src/core/operate/meta-digest.ts";
import { retroSeat } from "../../src/core/operate/meta-retro.ts";
import {
  metaStepOpKey,
  readWatermark,
} from "../../src/core/operate/watermark.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import {
  fileSeat,
  learn,
  metaProcess,
  morningPolicy,
  needsHuman,
  packetEvents,
  retroDueRun,
  retroLaunch,
  retroRecorded,
  seedMorning,
} from "./meta-digest-seed.ts";
import { metaInput, metaTable, ran, seedMeta } from "./meta-seed.ts";
import { createRun, replay } from "./run-fixture.ts";
import { activeRevision } from "./seed.ts";

const t0 = new Date("2026-11-15T08:00:00.000Z");
const after = new Date("2026-11-15T10:30:00.000Z");
const later = new Date("2026-11-15T11:00:00.000Z");
const nextDay = new Date("2026-11-16T10:30:00.000Z");
const thirdDay = new Date("2026-11-17T10:30:00.000Z");

let conn: Connection;

function stepOf(
  steps: readonly MetaStepRecord[] | undefined,
  name: "retro" | "digest",
) {
  return steps?.find((each) => each.step === name);
}

async function slot(at: Date, over: Partial<MetaDeps> = {}, name?: string) {
  const outcome = ran(
    await runMeta(conn.db, metaInput(at, name), metaTable(conn, over)),
  );
  return outcome.slots[0]?.steps;
}

async function digestOnly(over: Partial<MetaDeps>) {
  const [record] = await runMetaSteps(
    conn.db,
    { host: "local", writer: "local", actor: "person:human", now: after },
    ["digest"],
    metaTable(conn, over),
  );
  return record;
}

async function digestEvents() {
  return conn.sql<{ op_key: string; meta: boolean }[]>`
    select op_key, payload ? 'meta' as meta from ledger.event
    where type = 'digest' order by id`;
}

async function proposals() {
  const [row] = await conn.sql<{ n: number }[]>`
    select count(*)::int as n from ledger.digest_proposal`;
  return row?.n;
}

describeDb("meta retro and digest steps", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  test("the slot retros a retro_due Run, replays its open Dispatch, and skips it once its retro event is written", async () => {
    await seedMorning(conn);
    await retroDueRun(conn, t0);
    const { orca } = replay(conn, retroLaunch);
    const first = await slot(after, { orca });
    orca.assertDone();
    expect(stepOf(first, "retro")).toMatchObject({
      op_key: metaStepOpKey("retro", "host:local", null),
      result: "ok",
      detail: {
        runs: [
          { run_id: "run_1", state: "dispatched", dispatch_id: "ctx_retro" },
        ],
        held: 0,
      },
    });
    const replayed = await slot(nextDay);
    expect(stepOf(replayed, "retro")).toMatchObject({
      result: "ok",
      detail: {
        runs: [
          { run_id: "run_1", state: "dispatched", dispatch_id: "ctx_retro" },
        ],
      },
    });
    await retroRecorded(conn, nextDay);
    const skipped = await slot(thirdDay);
    expect(stepOf(skipped, "retro")).toMatchObject({
      result: "ok",
      detail: { runs: [], held: 0 },
    });
  });

  test("a retro-capable seat holding a Dispatch on another Task of the Run is skipped", async () => {
    await seedMorning(conn);
    await retroDueRun(conn, t0);
    const run = await conn.db.getRun("run_1");
    if (run === null) throw new Error("no run_1");
    expect(await retroSeat(conn.db, run, "local")).toBe("dev-retro");
    await clearDb(conn);
    await seedMorning(conn);
    await retroDueRun(conn, t0, "dev-retro");
    expect(await retroSeat(conn.db, run, "local")).toBe("retro-1");
  });

  test("the digest Seat's FILE is posted to the cap and the verified output moves the watermark", async () => {
    await seedMorning(conn);
    await learn(conn, "one", t0);
    await learn(conn, "two", t0);
    await learn(conn, "three", t0);
    const requests: MetaSeatRequest[] = [];
    const steps = await slot(after, { seat: fileSeat(requests) });
    const digest = stepOf(steps, "digest");
    expect(digest).toMatchObject({
      op_key: metaStepOpKey("digest", "global", null),
      result: "ok",
      detail: { day: "2026-11-15", queued: 1, truncated: false },
    });
    expect((digest?.detail as { shown: number[] }).shown).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.packet).not.toMatch(/learning:\d/u);
    expect(requests[0]).toMatchObject({
      step: "digest",
      role: "digest",
      method: metaProcess.steps[0]?.method,
      scope: "global",
    });
    const learningEvents = await conn.sql<{ id: number; ts: Date }[]>`
      select id::int as id, ts from ledger.event where type = 'learning' order by id`;
    expect(packetEvents(requests[0])).toEqual(
      learningEvents.map((row) => row.id),
    );
    const last = learningEvents.at(-1);
    expect(await readWatermark(conn.db, "digest", "digest", "global")).toEqual({
      event_id: last?.id,
      ts: new Date(last?.ts ?? 0).toISOString(),
    });
    expect(await digestEvents()).toEqual([
      { op_key: "digest:global:2026-11-15", meta: false },
      { op_key: digest?.op_key, meta: true },
    ]);
  });

  test("a failed readback keeps the watermark, and the rerun under the same op-key posts once", async () => {
    await seedMorning(conn);
    await createRun(conn);
    await learn(conn, "one", t0);
    await needsHuman(conn, "dec-1", t0, "agreed");
    const requests: MetaSeatRequest[] = [];
    const seat = fileSeat(requests);
    const failed = await slot(after, {
      seat,
      readback: () => Promise.resolve(false),
    });
    const first = stepOf(failed, "digest");
    expect(first).toMatchObject({
      result: "failed",
      detail: { code: "readback_failed" },
    });
    expect(
      await readWatermark(conn.db, "digest", "digest", "global"),
    ).toBeNull();
    expect(await proposals()).toBe(1);

    const rerun = stepOf(await slot(later, { seat }, "morning"), "digest");
    expect(rerun).toMatchObject({ op_key: first?.op_key, result: "ok" });
    expect(await proposals()).toBe(1);
    expect(await digestEvents()).toEqual([
      { op_key: "digest:global:2026-11-15", meta: false },
      { op_key: first?.op_key, meta: true },
    ]);
  });

  test("a ruled needs_human Decision is escalation input, and an unruled one is left out", async () => {
    await seedMorning(conn);
    await createRun(conn);
    await needsHuman(conn, "dec-ruled", t0, "agreed");
    await needsHuman(conn, "dec-open", t0, null);
    const prepared = await prepareDigest(conn.db, {
      project: null,
      host: "local",
      now: () => after,
    });
    if (!prepared.ok) throw new Error(prepared.refusal.message);
    expect(prepared.escalations).toEqual([
      {
        decision_id: "dec-ruled",
        event_id: expect.any(Number),
        verb: "agreed",
        author: "person-a",
        reason: "disagreement",
        note: "ship it",
      },
    ]);
    expect(prepared.packet.items).toEqual([
      {
        event_id: prepared.escalations[0]?.event_id,
        kind: "ruling",
        text: "decision dec-ruled agreed by person-a: reason disagreement; note ship it",
      },
    ]);
    const requests: MetaSeatRequest[] = [];
    await slot(after, { seat: fileSeat(requests) });
    expect(packetEvents(requests[0])).toEqual(
      prepared.packet.items.map((item) => item.event_id),
    );
  });

  test("a Seat failure, an unreadable FILE, and a FILE that fails the schema are failed and post nothing", async () => {
    await seedMorning(conn);
    await learn(conn, "one", t0);
    const failing = (
      result: Awaited<ReturnType<MetaSeat["run"]>>,
    ): MetaSeat => ({
      built: true,
      run: () => Promise.resolve(result),
    });
    expect(
      await digestOnly({ seat: failing({ ok: false, message: "seat ended" }) }),
    ).toMatchObject({
      result: "failed",
      detail: { code: "seat_failed", message: "seat ended" },
    });
    expect(
      await digestOnly({
        seat: failing({ ok: true, file: "/no/such/file.yaml" }),
      }),
    ).toMatchObject({ result: "failed", detail: { code: "file_unreadable" } });
    const requests: MetaSeatRequest[] = [];
    const bad = fileSeat(requests);
    const schema: MetaSeat = {
      built: true,
      run: async (request) => {
        const written = await bad.run(request);
        if (!written.ok) return written;
        writeFileSync(
          written.file,
          "- theme: t\n  text: x\n  learning_ids: []\n  evidence_refs: []\n",
        );
        return written;
      },
    };
    expect(await digestOnly({ seat: schema })).toMatchObject({
      result: "failed",
      detail: { code: "schema_invalid" },
    });
    expect(await proposals()).toBe(0);
    expect(await digestEvents()).toEqual([]);
  });

  test("an empty packet still needs exactly one meta process before it posts", async () => {
    await seedMorning(conn);
    await activeRevision(conn.db, "process", "meta-2", metaProcess);
    expect(await digestOnly({ seat: fileSeat([]) })).toMatchObject({
      result: "failed",
      detail: { code: "selector_many" },
    });
    await clearDb(conn);
    await seedMeta(conn, undefined, morningPolicy);
    expect(await digestOnly({ seat: fileSeat([]) })).toMatchObject({
      result: "failed",
      detail: { code: "config_missing" },
    });
    expect(await digestEvents()).toEqual([]);
  });

  test("a digest Seat that returns after packet_minutes posts nothing and moves no watermark", async () => {
    await seedMorning(conn);
    await learn(conn, "one", t0);
    const requests: MetaSeatRequest[] = [];
    const files = fileSeat(requests);
    let started: () => void = () => undefined;
    const launched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let returned: Promise<unknown> = Promise.resolve();
    const late: MetaSeat = {
      built: true,
      run: (request) => {
        const result = new Promise<Awaited<ReturnType<MetaSeat["run"]>>>(
          (resolve) =>
            request.signal.addEventListener("abort", () => {
              resolve(files.run(request));
            }),
        );
        returned = result;
        started();
        return result;
      },
    };
    const expired: MetaClock = { deadline: () => launched };
    const outcome = ran(
      await runMeta(
        conn.db,
        metaInput(after),
        metaTable(conn, { seat: late }),
        expired,
      ),
    );
    expect(stepOf(outcome.slots[0]?.steps, "digest")).toMatchObject({
      result: "timed_out",
    });
    await returned;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toHaveLength(1);
    expect(await proposals()).toBe(0);
    expect(await digestEvents()).toEqual([]);
    expect(
      await readWatermark(conn.db, "digest", "digest", "global"),
    ).toBeNull();
  });

  test("two meta processes are selector_many, and none is config_missing", async () => {
    await seedMorning(conn);
    await learn(conn, "one", t0);
    await activeRevision(conn.db, "process", "meta-2", metaProcess);
    expect(await digestOnly({ seat: fileSeat([]) })).toMatchObject({
      result: "failed",
      detail: { code: "selector_many" },
    });
    await clearDb(conn);
    await seedMeta(conn, undefined, morningPolicy);
    await learn(conn, "one", t0);
    expect(await digestOnly({ seat: fileSeat([]) })).toMatchObject({
      result: "failed",
      detail: { code: "config_missing" },
    });
  });
});
