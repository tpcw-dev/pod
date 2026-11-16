import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { MetaClock, MetaStep } from "../../src/core/operate/meta.ts";
import { metaSteps, runMeta } from "../../src/core/operate/meta.ts";
import {
  cutPacket,
  type Packet,
  type PacketItem,
} from "../../src/core/operate/packet.ts";
import {
  metaStepOpKey,
  readWatermark,
  writeVerifiedOutput,
} from "../../src/core/operate/watermark.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { host, metaInput, ran, seedMeta } from "./meta-seed.ts";

const t0 = new Date("2026-11-15T10:30:00.000Z");
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

function item(event_id: number, text = `item ${event_id}`): PacketItem {
  return { event_id, ts: new Date(event_id * 1000), kind: "evidence", text };
}

test("the item cap keeps the oldest items and holds the rest with one routing line", () => {
  const packet = cutPacket(
    [item(5), item(3), item(1), item(4), item(2)],
    { items: 3, words: 2000 },
    null,
  );
  expect(packet.items.map((each) => each.event_id)).toEqual([1, 2, 3]);
  expect(packet).toMatchObject({
    truncated: true,
    held: 2,
    words: 6,
    bound: { event_id: 3, ts: new Date(3000).toISOString() },
    routing:
      "truncated: 2 items held for the next packet, oldest event 4; caps packet_items 3, packet_words 2000",
  });
});

test("the word cap stops before the item that would pass it", () => {
  const packet = cutPacket(
    [item(1, words(200)), item(2, words(200)), item(3, words(200))],
    { items: 20, words: 500 },
    null,
  );
  expect(packet.items.map((each) => each.event_id)).toEqual([1, 2]);
  expect(packet).toMatchObject({ words: 400, truncated: true, held: 1 });
});

test("an oversized first item is sent alone rather than dropped", () => {
  const packet = cutPacket(
    [item(1, words(900)), item(2)],
    { items: 20, words: 500 },
    null,
  );
  expect(packet.items.map((each) => each.event_id)).toEqual([1]);
  expect(packet).toMatchObject({ words: 900, truncated: true, held: 1 });
});

test("an uncut packet has no routing line, repeats count once, and an empty one keeps the watermark", () => {
  const watermark = { event_id: 9, ts: new Date(9000).toISOString() };
  expect(
    cutPacket([item(2), item(2)], { items: 20, words: 2000 }, null),
  ).toMatchObject({ truncated: false, routing: null, held: 0, words: 2 });
  expect(cutPacket([], { items: 20, words: 2000 }, watermark)).toEqual({
    items: [],
    words: 0,
    truncated: false,
    routing: null,
    held: 0,
    bound: watermark,
  });
  expect(
    cutPacket([item(4)], { items: 20, words: 2000 }, watermark).bound,
  ).toEqual(watermark);
});

describeDb("the packet and the verified watermark", () => {
  let conn: Connection;
  const scope = `host:${host}`;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function evidence(text: string): Promise<number> {
    const appended = await conn.db.appendEvent({
      type: "learning",
      ts: t0,
      host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { text },
      source: { kind: "command" },
    });
    return appended.id;
  }

  async function outputs(): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = 'retro'`;
    return row?.n ?? -1;
  }

  function retro(
    seen: Packet[],
    run: MetaStep["run"] = async (ctx) => {
      if (ctx.packet.bound === null) return { result: "ok", detail: null };
      const written = await writeVerifiedOutput(ctx.db, {
        type: "retro",
        ts: ctx.now,
        host: ctx.writer,
        payload: { items: ctx.packet.items.length },
        source: { kind: "command" },
        ref: { step: ctx.step, scope: ctx.scope, input: ctx.packet.bound },
        opKey: ctx.opKey,
        readback: () => Promise.resolve(true),
      });
      return { result: written.written ? "ok" : "failed", detail: null };
    },
  ): MetaStep[] {
    return metaSteps.map((each) =>
      each.name === "retro"
        ? {
            ...each,
            built: true,
            input: async (repo, ctx) =>
              (await repo.eventsWith("learning", {}))
                .filter((row) => row.id > (ctx.watermark?.event_id ?? 0))
                .map((row) => ({
                  event_id: row.id,
                  ts: row.ts,
                  kind: "evidence" as const,
                  text: String((row.payload as { text: string }).text),
                })),
            run: (ctx) => {
              seen.push(ctx.packet);
              return run(ctx);
            },
          }
        : each,
    );
  }

  const slot = [{ name: "morning", at: "05:00", steps: ["retro"] }];
  const capped = (items: number) => ({
    limits: { packet_items: items, packet_words: 2000, packet_minutes: 30 },
  });

  test("a truncated item is sent first in the next packet, and the watermark follows the verified output", async () => {
    await seedMeta(conn, slot, capped(2));
    const ids = [await evidence("a"), await evidence("b"), await evidence("c")];
    const seen: Packet[] = [];
    ran(await runMeta(conn.db, metaInput(t0), retro(seen)));
    expect(seen[0]?.items.map((each) => each.event_id)).toEqual(
      ids.slice(0, 2),
    );
    expect(seen[0]?.truncated).toBe(true);
    expect(await readWatermark(conn.db, "retro", "retro", scope)).toEqual({
      event_id: ids[1],
      ts: t0.toISOString(),
    });
    ran(await runMeta(conn.db, metaInput(day(1)), retro(seen)));
    expect(seen[1]?.items.map((each) => each.event_id)).toEqual([ids[2]]);
    expect(seen[1]?.truncated).toBe(false);
  });

  test("past packet_minutes the step is timed_out and the watermark does not move", async () => {
    await seedMeta(conn, slot);
    await evidence("a");
    const seen: Packet[] = [];
    let aborted = false;
    const stalled = retro(
      seen,
      (ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ result: "ok", detail: null });
          }),
        ),
    );
    const minutes: number[] = [];
    const expired: MetaClock = {
      deadline: (limit) => {
        minutes.push(limit);
        return Promise.resolve();
      },
    };
    const outcome = ran(
      await runMeta(conn.db, metaInput(t0), stalled, expired),
    );
    expect(outcome.slots[0]?.steps[0]).toEqual({
      step: "retro",
      op_key: metaStepOpKey("retro", scope, null),
      result: "timed_out",
      detail: { packet_minutes: 30 },
    });
    expect(minutes).toEqual([30]);
    expect(aborted).toBe(true);
    expect(await outputs()).toBe(0);
    expect(await readWatermark(conn.db, "retro", "retro", scope)).toBeNull();
    const rerun = ran(await runMeta(conn.db, metaInput(day(1)), retro(seen)));
    expect(rerun.slots[0]?.steps[0]?.op_key).toBe(
      metaStepOpKey("retro", scope, null),
    );
    expect(seen[1]?.items).toHaveLength(1);
  });

  test("a failed readback writes no output and keeps the watermark", async () => {
    await seedMeta(conn, slot);
    const id = await evidence("a");
    const written = await writeVerifiedOutput(conn.db, {
      type: "retro",
      ts: t0,
      host,
      payload: {},
      source: { kind: "command" },
      ref: {
        step: "retro",
        scope,
        input: { event_id: id, ts: t0.toISOString() },
      },
      opKey: metaStepOpKey("retro", scope, null),
      readback: () => Promise.resolve(false),
    });
    expect(written).toEqual({
      written: false,
      event_id: null,
      replayed: false,
    });
    expect(await outputs()).toBe(0);
    expect(await readWatermark(conn.db, "retro", "retro", scope)).toBeNull();
  });

  test("a rerun of the same packet writes its output once", async () => {
    await seedMeta(conn, slot);
    const id = await evidence("a");
    const output = {
      type: "retro" as const,
      ts: t0,
      host,
      payload: {},
      source: { kind: "command" },
      ref: {
        step: "retro" as const,
        scope,
        input: { event_id: id, ts: t0.toISOString() },
      },
      opKey: metaStepOpKey("retro", scope, null),
      readback: () => Promise.resolve(true),
    };
    const first = await writeVerifiedOutput(conn.db, output);
    const second = await writeVerifiedOutput(conn.db, output);
    expect(first).toMatchObject({ written: true, replayed: false });
    expect(second).toEqual({ ...first, replayed: true });
    expect(await outputs()).toBe(1);
  });

  test("an unverified or malformed output does not move the watermark", async () => {
    await seedMeta(conn, slot);
    const id = await evidence("a");
    for (const meta of [
      {
        step: "retro",
        scope,
        input: { event_id: id, ts: t0.toISOString() },
        verified: false,
      },
      { step: "retro", scope, input: { event_id: "x" }, verified: true },
    ])
      await conn.db.appendEvent({
        type: "retro",
        ts: t0,
        host,
        run_id: null,
        task_id: null,
        dispatch_id: null,
        op_key: null,
        payload: { meta },
        source: { kind: "command" },
      });
    expect(await readWatermark(conn.db, "retro", "retro", scope)).toBeNull();
  });
});
