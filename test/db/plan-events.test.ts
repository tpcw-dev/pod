import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { publishPlan, readPlan } from "../../src/core/plan/plan.ts";
import { writeOverride } from "../../src/core/plan/write.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { hostValue } from "./seed.ts";

const zone = "America/Los_Angeles";
const nov14 = new Date("2026-11-14T18:00:00.000Z");
const nov15 = new Date("2026-11-15T18:00:00.000Z");
const nov14End = "2026-11-15T08:00:00.000Z";
const actor = "person:human";
const sources = { tracker: null, docs: null };

describeDb("pod plan events", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function activeHost(value: Json, hostId = "local"): Promise<string> {
    const revision = await storeRevision(conn.db, {
      ...envelope("host", hostId, value),
      scope: "host",
      scope_ref: hostId,
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: hostId,
      kind: "host",
      name: hostId,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: nov14,
    });
    if (!activated.ok) throw new Error("host not activated");
    return revision.id;
  }

  function seedHost(): Promise<string> {
    return activeHost({ ...(hostValue(2) as object), timezone: zone });
  }

  function hold(key: string, now: Date, until: string | null = null) {
    return writeOverride(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now,
      request: { kind: "hold", key, reason: "waits on a fix", until },
    });
  }

  function priority(projects: string[], now: Date, until: string | null) {
    return writeOverride(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now,
      request: { kind: "priority", projects, until },
    });
  }

  async function planAt(now: Date) {
    const plan = await readPlan(conn.db, { host: "local", now, sources });
    if (!plan.ok) throw new Error(plan.refusal.message);
    return plan;
  }

  async function planEvents(): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = 'plan'`;
    return row?.n ?? -1;
  }

  test("pod plan prints capacity, no overrides, and an empty ranked list", async () => {
    const revision = await seedHost();
    const result = runCli(["plan"]);
    expect(result).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: {
          host: "local",
          timezone: zone,
          host_revision: revision,
          capacity: { slots_default: 2, slots_max: 2, reserved: {} },
          overrides: { holds: [], priority: null, order: null },
          ranked: [],
          held: [],
          published: null,
        },
      },
    });
  });

  test("a later published plan replaces the earlier one for the same host and day", async () => {
    await seedHost();
    const first = runCli(["plan", "--publish"]);
    expect(first).toMatchObject({ status: 0, json: { ok: true } });
    expect(runCli(["plan", "hold", "TPC-1", "--reason", "waits"]).status).toBe(
      0,
    );
    const second = runCli(["plan", "--publish"]);
    expect(second).toMatchObject({
      status: 0,
      json: { ok: true, result: { held: [{ key: "TPC-1", reason: "waits" }] } },
    });
    const firstId = (first.json.result?.["published"] as { event_id: number })
      .event_id;
    const secondId = (second.json.result?.["published"] as { event_id: number })
      .event_id;
    expect(secondId).toBeGreaterThan(firstId);
    expect(runCli(["plan"]).json.result).toMatchObject({
      published: { event_id: secondId, held: [{ key: "TPC-1" }] },
    });
  });

  test("a published plan records its inputs: the host Revision and the overrides in force", async () => {
    const revision = await seedHost();
    const held = runCli(["plan", "hold", "TPC-2", "--reason", "waits"]);
    const published = runCli(["plan", "--publish"]);
    const [row] = await conn.sql<{ payload: Record<string, Json> }[]>`
      select payload from ledger.event
      where type = 'plan' and payload->>'kind' = 'published'`;
    expect(row?.payload).toMatchObject({
      kind: "published",
      host: "local",
      ranked: [],
      held: [{ key: "TPC-2", reason: "waits" }],
      actor,
      inputs: {
        host_revision: revision,
        project_revisions: [],
        tracker: null,
        usage_observation_ids: [],
        overrides: [held.json.result?.["event_id"]],
      },
    });
    expect(published.json.result?.["published"]).toMatchObject({
      replayed: false,
    });
  });

  test("an override expires at the end of the host's day", async () => {
    await seedHost();
    const held = await hold("TPC-3", nov14);
    expect(held).toMatchObject({
      ok: true,
      day: "2026-11-14",
      expires_at: nov14End,
    });
    expect((await planAt(nov14)).overrides.holds).toMatchObject([
      { key: "TPC-3", actor },
    ]);
    expect(
      (await planAt(new Date("2026-11-15T07:59:59.000Z"))).overrides.holds,
    ).toHaveLength(1);
    expect((await planAt(new Date(nov14End))).overrides.holds).toEqual([]);
  });

  test("--until keeps an override in force past the day", async () => {
    await seedHost();
    const held = await hold("TPC-4", nov14, "2026-11-16");
    expect(held).toMatchObject({
      ok: true,
      expires_at: "2026-11-17T08:00:00.000Z",
    });
    expect((await planAt(nov15)).overrides.holds).toMatchObject([
      { key: "TPC-4", until: "2026-11-16" },
    ]);
  });

  test("a newer priority that expires does not bring back an older one", async () => {
    await seedHost();
    expect(await priority(["alpha"], nov14, "2026-11-20")).toMatchObject({
      ok: true,
    });
    expect(await priority(["beta"], nov14, null)).toMatchObject({ ok: true });
    expect((await planAt(nov14)).overrides.priority).toMatchObject({
      projects: ["beta"],
    });
    expect((await planAt(nov15)).overrides.priority).toBeNull();
  });

  test("release ends a hold, a retried release replays, and a release with no hold in force is not_held", async () => {
    await seedHost();
    expect(runCli(["plan", "hold", "TPC-5", "--reason", "waits"]).status).toBe(
      0,
    );
    expect(runCli(["plan", "release", "TPC-5"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { kind: "release", key: "TPC-5" } },
    });
    expect(runCli(["plan"]).json.result).toMatchObject({
      overrides: { holds: [] },
    });
    expect(runCli(["plan", "release", "TPC-5"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { replayed: true } },
    });
    expect(runCli(["plan", "release", "TPC-55"])).toMatchObject({
      status: 3,
      json: { ok: false, error: { code: "not_held" } },
    });
  });

  test("a retried call writes once, and the same hold after a release writes again", async () => {
    await seedHost();
    const first = await hold("TPC-6", nov14);
    const retried = await hold("TPC-6", nov14);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(retried).toMatchObject({ ok: true, replayed: true });
    if (!first.ok || !retried.ok) throw new Error("hold refused");
    expect(retried.op_key).toBe(first.op_key);
    expect(retried.event_id).toBe(first.event_id);
    expect(await planEvents()).toBe(1);

    const released = await writeOverride(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now: nov14,
      request: { kind: "release", key: "TPC-6" },
    });
    expect(released).toMatchObject({ ok: true });
    const again = await hold("TPC-6", nov14);
    expect(again).toMatchObject({
      ok: true,
      replayed: false,
      op_key: `${first.op_key}:2`,
    });
    expect(await planEvents()).toBe(3);
    expect((await planAt(nov14)).overrides.holds).toMatchObject([
      { key: "TPC-6" },
    ]);
  });

  test("a retried publish writes once", async () => {
    await seedHost();
    const first = await publishPlan(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now: nov14,
      sources,
    });
    const retried = await publishPlan(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now: nov14,
      sources,
    });
    expect(first).toMatchObject({ ok: true, published: { replayed: false } });
    expect(retried).toMatchObject({ ok: true, published: { replayed: true } });
    expect(await planEvents()).toBe(1);
  });

  test("order keeps its keys in order, and a repeated key is usage", async () => {
    await seedHost();
    expect(runCli(["plan", "order", "TPC-9", "TPC-7", "TPC-8"])).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: { kind: "order", keys: ["TPC-9", "TPC-7", "TPC-8"] },
      },
    });
    expect(runCli(["plan"]).json.result).toMatchObject({
      overrides: { order: { keys: ["TPC-9", "TPC-7", "TPC-8"], actor } },
    });
    expect(runCli(["plan", "order", "TPC-9", "TPC-9"])).toMatchObject({
      status: 2,
      json: { ok: false, error: { code: "usage" } },
    });
  });

  test("--until before the host's day, or not a date, is usage", async () => {
    await seedHost();
    for (const until of ["2020-01-01", "2026-02-30", "tomorrow"])
      expect(
        runCli(["plan", "hold", "TPC-10", "--reason", "r", "--until", until]),
      ).toMatchObject({
        status: 2,
        json: { ok: false, error: { code: "usage" } },
      });
  });

  test("an agent Seat may write an override, and pod plan shows its actor", async () => {
    await seedHost();
    expect(
      runCli(["plan", "priority", "alpha", "beta"], { POD_SEAT: "lead-seat" }),
    ).toMatchObject({ status: 0, json: { ok: true } });
    expect(runCli(["plan"]).json.result).toMatchObject({
      overrides: {
        priority: { projects: ["alpha", "beta"], actor: "seat:lead-seat" },
      },
    });
  });

  test("a host with no active Revision, or one with no timezone, is config_missing", async () => {
    const missing = runCli(["plan"]);
    expect(missing).toMatchObject({
      status: 3,
      json: { ok: false, error: { code: "config_missing" } },
    });
    expect(missing.json.error?.nextSteps[0]).toBe(
      "pod config apply specs/host/local.yaml --ticket K",
    );
    const bare = Object.fromEntries(
      Object.entries(hostValue(2) as Record<string, Json>).filter(
        ([key]) => key !== "timezone",
      ),
    );
    await activeHost(bare);
    const result = runCli(["plan", "hold", "TPC-11", "--reason", "r"]);
    expect(result).toMatchObject({
      status: 3,
      json: { ok: false, error: { code: "config_missing" } },
    });
    expect(result.json.error?.nextSteps[0]).toContain(
      "pod config set host.local timezone=",
    );
  });

  test("--host plans another host's day from its own Revision", async () => {
    await seedHost();
    await activeHost(
      {
        ...(hostValue(1) as object),
        hostnames: ["host-b"],
        timezone: "Asia/Taipei",
      },
      "other",
    );
    expect(runCli(["plan", "--host", "other"]).json.result).toMatchObject({
      host: "other",
      timezone: "Asia/Taipei",
      capacity: { slots_default: 1 },
    });
    expect(
      runCli(["plan", "hold", "TPC-12", "--reason", "r", "--host", "other"])
        .status,
    ).toBe(0);
    expect(runCli(["plan"]).json.result).toMatchObject({
      overrides: { holds: [] },
    });
  });
});
