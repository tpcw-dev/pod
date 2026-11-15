import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Kind } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { derivedOpKey } from "../../src/core/ledger/op-key.ts";
import {
  dryRunTick,
  runSteps,
  runTick,
  stepOpKey,
  tickSteps,
  type TickInput,
  type TickOutcome,
  type TickStep,
} from "../../src/core/operate/tick.ts";
import {
  recordTriggers,
  type TriggerInput,
} from "../../src/core/operate/triggers.ts";
import { publishPlan } from "../../src/core/plan/plan.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { hostValue } from "./seed.ts";

const t0 = new Date("2026-11-15T16:00:00.000Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);
const order = [
  "read_plan",
  "observe",
  "close",
  "launch",
  "attention",
  "write_tick",
];

function ran(outcome: TickOutcome | Refused): TickOutcome {
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome;
}

function input(
  now: Date,
  triggers: TriggerInput[] = [],
  host = "local",
): TickInput {
  return { host, writer: "local", actor: "person:human", now, triggers };
}

function operator(id: string): TriggerInput {
  return { source: "operator", trigger_id: id };
}

describeDb("pod tick", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function activate(kind: Kind, name: string, host: string, value: Json) {
    const revision = await storeRevision(conn.db, {
      ...envelope(kind, name, value),
      scope: "host",
      scope_ref: host,
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: host,
      kind,
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: t0,
    });
    if (!activated.ok) throw new Error(`${kind} not activated`);
    return revision.id;
  }

  async function seed(host = "local"): Promise<string> {
    await activate("host", host, host, hostValue(2));
    return activate("schedule", "default", host, {
      tick_minutes: 15,
      hold_minutes: 60,
    });
  }

  async function count(type: string): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = ${type}`;
    return row?.n ?? -1;
  }

  function withStep(name: string, step: Partial<TickStep>): TickStep[] {
    return tickSteps.map((each) =>
      each.name === name ? { ...each, ...step } : each,
    );
  }

  test("the tick event lists the six steps in order, each with its derived op-key", async () => {
    const schedule = await seed();
    const published = await publishPlan(conn.db, {
      host: "local",
      writer: "local",
      actor: "person:human",
      now: t0,
    });
    if (!published.ok || published.published === null)
      throw new Error("plan not published");
    const planEvent = published.published.event_id;
    const tick = ran(await runTick(conn.db, input(t0)));
    expect(tick.outcome).toBe("ran");
    expect(tick.schedule_revision).toBe(schedule);
    expect(tick.steps.map((each) => each.step)).toEqual(order);
    expect(tick.steps.map((each) => each.result)).toEqual([
      "ok",
      "not_built",
      "not_built",
      "not_built",
      "not_built",
      "ok",
    ]);
    for (const each of tick.steps)
      expect(each.op_key).toBe(
        derivedOpKey("tick", {
          host: "local",
          step: each.step,
          subject: String(planEvent),
          story: "",
        }),
      );
    const [row] = await conn.sql<{ payload: Record<string, Json> }[]>`
      select payload from ledger.event where type = 'tick'`;
    expect(row?.payload).toMatchObject({
      host: "local",
      tick_id: tick.tick_id,
      plan_event: planEvent,
      schedule_revision: schedule,
      launch: [],
      refuse: [],
    });
  });

  test("a failing step is recorded and later steps still run", async () => {
    await seed();
    const called: string[] = [];
    const steps = withStep("observe", {
      built: true,
      run: () => Promise.reject(new Error("observe broke")),
    }).map((each) =>
      each.name === "close" || each.name === "attention"
        ? {
            ...each,
            built: true,
            run: () => {
              called.push(each.name);
              return Promise.resolve({ result: "ok" as const, detail: null });
            },
          }
        : each,
    );
    const tick = ran(await runTick(conn.db, input(t0), steps));
    expect(tick.steps[1]).toMatchObject({
      step: "observe",
      result: "failed",
      detail: { message: "observe broke" },
    });
    expect(called).toEqual(["close", "attention"]);
    expect(tick.steps[5]).toMatchObject({ step: "write_tick", result: "ok" });
  });

  test("launch does not run after an incomplete read", async () => {
    await activate("schedule", "default", "local", {
      tick_minutes: 15,
      hold_minutes: 60,
    });
    let launched = 0;
    const steps = withStep("launch", {
      built: true,
      run: () => {
        launched += 1;
        return Promise.resolve({ result: "ok", detail: null });
      },
    });
    const tick = ran(await runTick(conn.db, input(t0), steps));
    expect(tick.steps[0]).toMatchObject({
      step: "read_plan",
      result: "failed",
      detail: { code: "config_missing" },
    });
    expect(tick.steps[3]).toMatchObject({ step: "launch", result: "skipped" });
    expect(launched).toBe(0);

    await activate("host", "local", "local", hostValue(2));
    const failingObserve = withStep("observe", {
      built: true,
      run: () => Promise.reject(new Error("orca unreachable")),
    }).map((each) => (each.name === "launch" ? (steps[3] ?? each) : each));
    const second = ran(
      await runTick(conn.db, input(minutes(20)), failingObserve),
    );
    expect(second.steps[0]?.result).toBe("ok");
    expect(second.steps[3]).toMatchObject({ result: "skipped" });
    expect(launched).toBe(0);

    const third = ran(await runTick(conn.db, input(minutes(40)), steps));
    expect(third.steps[3]).toMatchObject({ result: "ok" });
    expect(launched).toBe(1);
  });

  test("with no trigger, a tick inside tick_minutes of the last one is not due and writes nothing", async () => {
    const schedule = await seed();
    expect(ran(await runTick(conn.db, input(t0))).outcome).toBe("ran");
    const early = ran(await runTick(conn.db, input(minutes(14))));
    expect(early).toMatchObject({
      outcome: "not due",
      due: false,
      schedule_revision: schedule,
      event_id: null,
      steps: [],
    });
    expect(await count("tick")).toBe(1);
    expect(ran(await runTick(conn.db, input(minutes(15)))).outcome).toBe("ran");
    expect(await count("tick")).toBe(2);
  });

  test("a pending trigger makes the tick due inside tick_minutes", async () => {
    await seed();
    ran(await runTick(conn.db, input(t0)));
    const tick = ran(
      await runTick(conn.db, input(minutes(1), [operator("op-1")])),
    );
    expect(tick.outcome).toBe("ran");
    expect(tick.consumed).toEqual([tick.recorded[0]?.event_id]);
  });

  test("a tick while another holds the host's lock records its trigger, prints coalesced, and the next tick consumes it", async () => {
    await seed();
    let coalesced: TickOutcome | null = null;
    await conn.sql.begin(async (held) => {
      await held`select pg_advisory_xact_lock(hashtext('tick:local'))`;
      coalesced = ran(await runTick(conn.db, input(t0, [operator("op-1")])));
    });
    expect(coalesced).toMatchObject({
      outcome: "coalesced",
      event_id: null,
      recorded: [{ source: "operator", trigger_id: "op-1", created: true }],
    });
    expect(await count("trigger")).toBe(1);
    expect(await count("tick")).toBe(0);
    const next = ran(await runTick(conn.db, input(minutes(1))));
    expect(next.outcome).toBe("ran");
    expect(next.consumed).toHaveLength(1);
    expect(next.pending).toEqual([]);
  });

  test("a trigger is written once and acknowledged by one tick only", async () => {
    await seed();
    const first = ran(
      await runTick(conn.db, input(t0, [operator("op-1"), operator("op-1")])),
    );
    expect(first.recorded.map((each) => each.created)).toEqual([true, false]);
    expect(await count("trigger")).toBe(1);
    expect(first.consumed).toHaveLength(1);
    const again = ran(
      await runTick(conn.db, input(minutes(1), [operator("op-1")])),
    );
    expect(again).toMatchObject({
      outcome: "not due",
      recorded: [{ created: false }],
    });
    const later = ran(await runTick(conn.db, input(minutes(30))));
    expect(later.consumed).toEqual([]);
  });

  test("ticks and triggers belong to the host in their payload, not to the writer", async () => {
    await seed("local");
    await seed("other");
    const other = ran(
      await runTick(conn.db, input(t0, [operator("op-b")], "other")),
    );
    expect(other.consumed).toHaveLength(1);
    const stored = ran(
      await runTick(conn.db, input(minutes(1), [operator("op-b")])),
    );
    expect(stored.recorded).toEqual([
      expect.objectContaining({ host: "other", created: false }),
    ]);
    expect(stored.outcome).toBe("ran");
    expect(stored.consumed).toEqual([]);
  });

  test("a crash before the tick event re-reads the same triggers and its keyed step does nothing twice", async () => {
    await seed();
    const created: boolean[] = [];
    const steps = withStep("observe", {
      built: true,
      run: async (ctx) => {
        const row = await ctx.db.insertOperation({
          op_key: ctx.opKey,
          intent: "tick",
          owner_generation: 0,
          at: ctx.now,
        });
        created.push(row.created);
        return { result: "ok", detail: { created: row.created } };
      },
    });
    const predecessor = ran(await runTick(conn.db, input(t0)));
    const [trigger] = await recordTriggers(conn.db, {
      ...input(minutes(1), [operator("op-1")]),
    });
    const crashed = await runSteps(conn.db, input(minutes(1)), steps);
    expect(await count("tick")).toBe(1);
    const rerun = ran(await runTick(conn.db, input(minutes(2)), steps));
    expect(created).toEqual([true, false]);
    expect(rerun.steps[1]).toMatchObject({
      op_key: crashed.steps[1]?.op_key,
      detail: { created: false },
    });
    expect(rerun.consumed).toEqual([trigger?.event_id]);
    expect(rerun.tick_id).toBe(
      derivedOpKey("tick", {
        host: "local",
        after: String(predecessor.event_id),
      }),
    );
  });

  test("with no active schedule Revision the tick refuses config_missing and keeps its trigger", async () => {
    await activate("host", "local", "local", hostValue(2));
    const refused = await runTick(conn.db, input(t0, [operator("op-1")]));
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "config_missing" },
    });
    expect(await count("trigger")).toBe(1);
  });

  test("a dry run writes nothing and plans the keys a real tick records", async () => {
    await seed();
    const dry = ran(
      await dryRunTick(conn.db, {
        host: "local",
        now: t0,
        triggers: [operator("op-1")],
      }),
    );
    expect(dry).toMatchObject({ outcome: "dry run", due: true });
    expect(dry.steps.map((each) => each.result)).toEqual([
      "planned",
      "not_built",
      "not_built",
      "not_built",
      "not_built",
      "planned",
    ]);
    expect(await count("trigger")).toBe(0);
    const [ops] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation where intent = 'tick'`;
    expect(ops?.n).toBe(0);
    const real = ran(await runTick(conn.db, input(t0)));
    expect(real.tick_id).toBe(dry.tick_id);
    expect(real.steps.map((each) => each.op_key)).toEqual(
      dry.steps.map((each) => each.op_key),
    );
    expect(real.steps[0]?.op_key).toBe(stepOpKey("local", "read_plan", null));
  });

  test("pod tick runs from the CLI and refuses a malformed trigger", async () => {
    await seed();
    expect(runCli(["tick", "--trigger", "bogus:1"])).toMatchObject({
      status: 2,
      json: { ok: false, error: { code: "usage" } },
    });
    expect(runCli(["tick", "--trigger", "operator"]).status).toBe(2);
    const first = runCli([
      "tick",
      "--trigger",
      "operator:a",
      "--trigger",
      "timer:b",
    ]);
    expect(first).toMatchObject({
      status: 0,
      json: { ok: true, result: { outcome: "ran", host: "local" } },
    });
    expect(first.json.result?.["consumed"]).toHaveLength(2);
    expect(runCli(["tick"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { outcome: "not due" } },
    });
    expect(runCli(["tick", "--dry-run"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { outcome: "dry run", due: false } },
    });
  });
});
