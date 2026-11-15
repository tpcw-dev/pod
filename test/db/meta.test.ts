import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import {
  dryRunMeta,
  metaSteps,
  runMeta,
  runMetaSteps,
  writeMetaTick,
  type MetaStep,
} from "../../src/core/operate/meta.ts";
import { runTick } from "../../src/core/operate/tick.ts";
import { idleSteps } from "./operate-ports.ts";
import {
  metaStepOpKey,
  writeVerifiedOutput,
} from "../../src/core/operate/watermark.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { host, metaInput, morning, ran, seedMeta } from "./meta-seed.ts";

const before = new Date("2026-11-15T09:30:00.000Z");
const after = new Date("2026-11-15T10:30:00.000Z");
const later = new Date("2026-11-15T20:00:00.000Z");
const nextDay = new Date("2026-11-16T10:30:00.000Z");

function built(name: "retro" | "digest", step: Partial<MetaStep>): MetaStep[] {
  return metaSteps.map((each) =>
    each.name === name ? { ...each, built: true, ...step } : each,
  );
}

describeDb("pod tick --agenda meta", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function metaTicks(): Promise<Record<string, Json>[]> {
    const rows = await conn.sql<{ payload: Record<string, Json> }[]>`
      select payload from ledger.event
      where type = 'tick' and payload->>'agenda' = 'meta' order by id`;
    return rows.map((row) => row.payload);
  }

  test("a slot past its time runs once, writing one meta tick event with each step's op-key", async () => {
    const schedule = await seedMeta(conn);
    const outcome = ran(await runMeta(conn.db, metaInput(after)));
    expect(outcome).toMatchObject({
      agenda: "meta",
      outcome: "ran",
      schedule_revision: schedule,
    });
    expect(outcome.slots).toHaveLength(1);
    const [slot] = outcome.slots;
    expect(slot).toMatchObject({ slot: "morning", due: true, replayed: false });
    expect(slot?.steps).toEqual([
      {
        step: "retro",
        op_key: metaStepOpKey("retro", `host:${host}`, null),
        result: "not_built",
        detail: null,
      },
      {
        step: "digest",
        op_key: metaStepOpKey("digest", `host:${host}`, null),
        result: "not_built",
        detail: null,
      },
    ]);
    expect(await metaTicks()).toEqual([
      {
        agenda: "meta",
        host,
        tick_id: slot?.tick_id,
        actor: "person:human",
        schedule_revision: schedule,
        slot: "morning",
        steps: slot?.steps,
      },
    ]);
  });

  test("a slot is not due before its time or after it ran that local day, and is due the next day", async () => {
    await seedMeta(conn);
    expect(ran(await runMeta(conn.db, metaInput(before)))).toMatchObject({
      outcome: "not due",
      slots: [],
    });
    expect(await metaTicks()).toHaveLength(0);
    ran(await runMeta(conn.db, metaInput(after)));
    expect(ran(await runMeta(conn.db, metaInput(later)))).toMatchObject({
      outcome: "not due",
    });
    expect(ran(await runMeta(conn.db, metaInput(nextDay)))).toMatchObject({
      outcome: "ran",
    });
    expect(await metaTicks()).toHaveLength(2);
  });

  test("a host with no meta slot is not due, and the operate schedule still parses", async () => {
    await seedMeta(conn, []);
    expect(ran(await runMeta(conn.db, metaInput(after)))).toMatchObject({
      outcome: "not due",
    });
  });

  test("a killed slot writes no tick event, so the next call runs it with the same op-keys", async () => {
    await seedMeta(conn);
    const killed = await runMetaSteps(
      conn.db,
      metaInput(after),
      morning.steps as ["retro", "digest"],
    );
    expect(await metaTicks()).toHaveLength(0);
    const rerun = ran(await runMeta(conn.db, metaInput(later)));
    expect(rerun.outcome).toBe("ran");
    expect(rerun.slots[0]?.steps.map((each) => each.op_key)).toEqual(
      killed.map((each) => each.op_key),
    );
  });

  test("a step output committed before a kill survives, and the rerun reads the moved watermark", async () => {
    await seedMeta(conn);
    const evidence = await conn.db.appendEvent({
      type: "learning",
      ts: before,
      host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { text: "one" },
      source: { kind: "command" },
    });
    const steps = built("retro", {
      input: () =>
        Promise.resolve([
          { event_id: evidence.id, ts: before, kind: "evidence", text: "one" },
        ]),
      run: async (ctx) => {
        if (ctx.packet.bound === null) throw new Error("empty packet");
        await writeVerifiedOutput(ctx.db, {
          type: "retro",
          ts: ctx.now,
          host: ctx.writer,
          payload: {},
          source: { kind: "command" },
          ref: { step: ctx.step, scope: ctx.scope, input: ctx.packet.bound },
          opKey: ctx.opKey,
          readback: () => Promise.resolve(true),
        });
        throw new Error("killed after the output");
      },
    });
    const killed = await runMetaSteps(
      conn.db,
      metaInput(after),
      ["retro"],
      steps,
    );
    expect(killed[0]).toMatchObject({ result: "failed" });
    const rerun = ran(await runMeta(conn.db, metaInput(later), steps));
    const moved = metaStepOpKey("retro", `host:${host}`, {
      event_id: evidence.id,
      ts: before.toISOString(),
    });
    expect(rerun.slots[0]?.steps[0]?.op_key).toBe(moved);
    expect(rerun.slots[0]?.steps[0]?.op_key).not.toBe(killed[0]?.op_key);
  });

  test("--slot runs a slot that is not due, and an unknown slot is usage", async () => {
    await seedMeta(conn);
    const forced = ran(await runMeta(conn.db, metaInput(before, "morning")));
    expect(forced).toMatchObject({
      outcome: "ran",
      slots: [{ slot: "morning", due: false }],
    });
    const again = ran(await runMeta(conn.db, metaInput(before, "morning")));
    expect(again.slots[0]?.tick_id).not.toBe(forced.slots[0]?.tick_id);
    expect(await metaTicks()).toHaveLength(2);
    expect(await runMeta(conn.db, metaInput(after, "evening"))).toMatchObject({
      ok: false,
      refusal: { code: "usage" },
    });
  });

  test("the meta lock and the operate lock do not block each other", async () => {
    await seedMeta(conn);
    const operateHeld = await conn.sql.begin(async (held) => {
      await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}`}))`;
      return {
        meta: await runMeta(conn.db, metaInput(after)),
        operate: await runTick(
          conn.db,
          { ...metaInput(after), triggers: [] },
          idleSteps(conn.db),
        ),
      };
    });
    expect(operateHeld.meta).toMatchObject({ outcome: "ran" });
    expect(operateHeld.operate).toMatchObject({ outcome: "coalesced" });
    const metaHeld = await conn.sql.begin(async (held) => {
      await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}:meta`}))`;
      return {
        meta: await runMeta(conn.db, metaInput(nextDay)),
        operate: await runTick(
          conn.db,
          { ...metaInput(after), triggers: [] },
          idleSteps(conn.db),
        ),
      };
    });
    expect(metaHeld.meta).toMatchObject({ outcome: "coalesced", slots: [] });
    expect(metaHeld.operate).toMatchObject({ outcome: "ran" });
  });

  test("a meta tick does not make the operate tick not due", async () => {
    await seedMeta(conn);
    ran(await runMeta(conn.db, metaInput(after)));
    expect(
      await runTick(
        conn.db,
        { ...metaInput(after), triggers: [] },
        idleSteps(conn.db),
      ),
    ).toMatchObject({ outcome: "ran" });
  });

  test("a failing step is recorded and the next step still runs", async () => {
    await seedMeta(conn);
    let digested = 0;
    const steps = built("retro", {
      run: () => Promise.reject(new Error("retro broke")),
    }).map((each) =>
      each.name === "digest"
        ? {
            ...each,
            built: true,
            run: () => {
              digested += 1;
              return Promise.resolve({ result: "ok" as const, detail: null });
            },
          }
        : each,
    );
    const outcome = ran(await runMeta(conn.db, metaInput(after), steps));
    expect(outcome.slots[0]?.steps).toMatchObject([
      { step: "retro", result: "failed", detail: { message: "retro broke" } },
      { step: "digest", result: "ok" },
    ]);
    expect(digested).toBe(1);
  });

  test("a built step without packet limits fails config_missing and the next step runs", async () => {
    await seedMeta(conn, [morning], { limits: {} });
    const outcome = ran(
      await runMeta(
        conn.db,
        metaInput(after),
        built("retro", {
          run: () => Promise.resolve({ result: "ok", detail: null }),
        }),
      ),
    );
    expect(outcome.slots[0]?.steps).toMatchObject([
      { step: "retro", result: "failed", detail: { code: "config_missing" } },
      { step: "digest", result: "not_built" },
    ]);
  });

  test("a replayed meta tick id returns the stored event", async () => {
    const schedule = await seedMeta(conn);
    const payload = {
      agenda: "meta" as const,
      host,
      tick_id: "tick:replay",
      actor: "person:human",
      schedule_revision: schedule,
      slot: "morning",
      steps: [],
    };
    const first = await writeMetaTick(
      conn.db,
      metaInput(after),
      "tick:replay",
      payload,
    );
    const second = await writeMetaTick(
      conn.db,
      metaInput(later),
      "tick:replay",
      payload,
    );
    expect(second).toEqual({ ...first, replayed: true });
    expect(await metaTicks()).toHaveLength(1);
  });

  test("a dry run writes nothing and lists each due slot's steps", async () => {
    await seedMeta(conn);
    const dry = ran(await dryRunMeta(conn.db, metaInput(after)));
    expect(dry).toMatchObject({
      outcome: "dry run",
      slots: [
        {
          slot: "morning",
          due: true,
          event_id: null,
          steps: [
            { step: "retro", result: "not_built" },
            { step: "digest", result: "not_built" },
          ],
        },
      ],
    });
    expect(
      ran(await dryRunMeta(conn.db, metaInput(after), built("retro", {})))
        .slots[0]?.steps[0],
    ).toMatchObject({ step: "retro", result: "planned" });
    expect(await metaTicks()).toHaveLength(0);
    const [ops] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation`;
    expect(ops?.n).toBe(0);
  });

  test("pod tick --agenda meta runs from the CLI and refuses an unknown slot", async () => {
    await seedMeta(conn);
    expect(runCli(["tick", "--agenda", "meta", "--dry-run"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { agenda: "meta", outcome: "dry run" } },
    });
    expect(
      runCli(["tick", "--agenda", "meta", "--slot", "morning"]),
    ).toMatchObject({
      status: 0,
      json: { ok: true, result: { agenda: "meta", outcome: "ran" } },
    });
    expect(
      runCli(["tick", "--agenda", "meta", "--slot", "evening"]),
    ).toMatchObject({
      status: 2,
      json: { ok: false, error: { code: "usage" } },
    });
    expect(await metaTicks()).toHaveLength(1);
  });
});
