import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { publishPlan, readPlan } from "../../src/core/plan/plan.ts";
import { writeOverride } from "../../src/core/plan/write.ts";
import type { DocsPort, Section } from "../../src/core/ports/docs.ts";
import { fakeTracker, listedStory, type FakeTracker } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { activeRevision, crewValue, hostValue, processValue } from "./seed.ts";

const zone = "America/Los_Angeles";
const now = new Date("2026-11-15T18:00:00.000Z");
const actor = "person:human";

const currentMilestone: Section = {
  heading: "Current milestone",
  paragraphs: ["M2 Operate | doing"],
  tables: [],
};

function roadmapDocs(current: Section | null): DocsPort {
  return {
    readSection({ heading }) {
      const found =
        heading === "Current milestone"
          ? current
          : { heading, paragraphs: [], tables: [] };
      return Promise.resolve({
        verb: "readSection",
        ok: found !== null,
        result: found,
        raw: null,
        error: found === null ? "timeout" : null,
        requestId: null,
      });
    },
  };
}

function story(key: string, over: Parameters<typeof listedStory>[0] = {}) {
  return listedStory({
    ref: { provider: "linear", external_id: key },
    title: `Story ${key}`,
    ...over,
  });
}

describeDb("pod plan candidates across projects", () => {
  let conn: Connection;
  let tracker: FakeTracker;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await clearDb(conn);
    tracker = fakeTracker();
    await activeRevision(conn.db, "process", "impl", processValue as Json);
  });
  afterAll(() => conn.close());

  async function activeHost(hostId: string, value: object): Promise<string> {
    const revision = await storeRevision(conn.db, {
      ...envelope("host", hostId, {
        ...(hostValue(2) as object),
        timezone: zone,
        ...value,
      } as Json),
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
      activated_at: now,
    });
    if (!activated.ok) throw new Error("host not activated");
    return revision.id;
  }

  async function project(name: string): Promise<string> {
    const revision = await activeRevision(conn.db, "project", name, {
      repo: `tpcw-dev/${name}`,
      category: "Meta",
      staging: false,
      tracker: { project_name: name, project_id: `id-${name}` },
    });
    return revision.id;
  }

  async function projectPolicy(name: string): Promise<void> {
    const revision = await storeRevision(
      conn.db,
      envelope("policy", name, {
        gates: ["pr"],
        roadmap: { provider: "notion", page: `page-${name}` },
      } as Json),
    );
    const activated = await conn.db.activate({
      scope: "project",
      scope_ref: name,
      kind: "policy",
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: now,
    });
    if (!activated.ok) throw new Error("policy not activated");
  }

  function read(docs: DocsPort | null = null) {
    return readPlan(conn.db, {
      host: "local",
      now,
      sources: { tracker, docs },
    });
  }

  function publish(docs: DocsPort | null = null) {
    return publishPlan(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now,
      sources: { tracker, docs },
    });
  }

  test("the plan ranks the Todo Stories of every seated project and holds the rest", async () => {
    await activeHost("local", { projects: ["pod", "process"] });
    await project("pod");
    await project("process");
    await project("quant");
    tracker.listings = {
      "id-pod": [
        story("TPC-1", { priority: 2 }),
        story("TPC-2", { labels: ["blocked"] }),
      ],
      "id-process": [story("TPC-3", { priority: 1 })],
      "id-quant": [story("TPC-4", { priority: 1 })],
    };
    const plan = await read();
    expect(plan).toMatchObject({
      ok: true,
      partial: [],
      ranked: [
        { key: "TPC-3", project: "process" },
        { key: "TPC-1", project: "pod" },
      ],
      held: [{ key: "TPC-2", reason: "label blocked", project: "pod" }],
    });
    expect(tracker.calls).toEqual([
      "listStories:id-pod",
      "listStories:id-process",
    ]);
  });

  test("a host that seats * takes the projects no other host seats", async () => {
    await activeHost("local", { projects: ["*"] });
    await activeHost("mini", { projects: ["quant"], hostnames: ["host-b"] });
    await project("pod");
    await project("quant");
    tracker.listings = {
      "id-pod": [story("TPC-1")],
      "id-quant": [story("TPC-4")],
    };
    expect(await read()).toMatchObject({ ranked: [{ key: "TPC-1" }] });
    expect(tracker.calls).toEqual(["listStories:id-pod"]);
  });

  test("the roadmap's current milestone places a Story current", async () => {
    await activeHost("local", { projects: ["pod"] });
    await project("pod");
    await projectPolicy("pod");
    tracker.listings = {
      "id-pod": [
        story("TPC-1", { milestone: "M3 Grow" }),
        story("TPC-2", { milestone: "M2 Operate" }),
      ],
    };
    expect(await read(roadmapDocs(currentMilestone))).toMatchObject({
      ranked: [
        { key: "TPC-2", place: "current" },
        { key: "TPC-1", place: "milestone" },
      ],
    });
  });

  test("a failed read prints the partial plan, and publish refuses tracker_partial", async () => {
    await activeHost("local", { projects: ["pod", "process"] });
    await project("pod");
    await project("process");
    await projectPolicy("process");
    tracker.listings = { "id-pod": [story("TPC-1")] };
    tracker.failList = ["id-pod"];
    expect(await read(roadmapDocs(null))).toMatchObject({
      ok: true,
      ranked: [],
      partial: [
        { project: "pod", error: "list_incomplete" },
        { project: "process", error: expect.stringMatching(/^roadmap: /) },
      ],
    });
    expect(await publish(roadmapDocs(null))).toMatchObject({
      ok: false,
      refusal: {
        code: "tracker_partial",
        message: expect.stringContaining(
          "Project pod read failed: list_incomplete.",
        ),
      },
    });
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = 'plan'`;
    expect(row?.n).toBe(0);
  });

  test("no tracker port is a partial read for each seated project", async () => {
    await activeHost("local", { projects: ["pod"] });
    await project("pod");
    const plan = await readPlan(conn.db, {
      host: "local",
      now,
      sources: { tracker: null, docs: null },
    });
    expect(plan).toMatchObject({
      partial: [{ project: "pod", error: "no tracker port" }],
    });
  });

  test("a published plan records the project Revisions and the tracker read", async () => {
    await activeHost("local", { projects: ["pod"], reserved: { pod: 1 } });
    const pod = await project("pod");
    tracker.listings = {
      "id-pod": [story("TPC-1"), story("TPC-2", { priority: 4 })],
    };
    const published = await publish();
    expect(published).toMatchObject({
      ok: true,
      reserved: [{ project: "pod", slots: 1, covers: ["TPC-1"] }],
      published: {
        ranked: [{ key: "TPC-1" }, { key: "TPC-2" }],
        inputs: {
          project_revisions: [pod],
          tracker: {
            hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            observed_at: now.toISOString(),
          },
        },
      },
    });
  });

  test("a hold names its project, and the held Story carries it", async () => {
    await activeHost("local", { projects: ["pod"] });
    await project("pod");
    tracker.listings = { "id-pod": [story("TPC-1")] };
    const held = await writeOverride(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now,
      request: {
        kind: "hold",
        key: "TPC-9",
        reason: "waits",
        until: null,
        project: "process",
      },
    });
    expect(held).toMatchObject({ ok: true, project: "process" });
    expect(await read()).toMatchObject({
      overrides: { holds: [{ key: "TPC-9", project: "process" }] },
      held: [{ key: "TPC-9", reason: "waits", project: "process" }],
    });
  });

  test("a host Revision that moves during the tracker read refuses revision_conflict", async () => {
    const first = await activeHost("local", { projects: ["pod"] });
    await project("pod");
    tracker.listings = { "id-pod": [story("TPC-1")] };
    const moved = await storeRevision(conn.db, {
      ...envelope("host", "local", {
        ...(hostValue(3) as object),
        timezone: zone,
        projects: ["pod"],
      } as Json),
      scope: "host",
      scope_ref: "local",
    });
    const list = tracker.listStories.bind(tracker);
    tracker.listStories = async (query) => {
      const activated = await conn.db.activate({
        scope: "host",
        scope_ref: "local",
        kind: "host",
        name: "local",
        expected: first,
        revision_id: moved.id,
        bundle_id: null,
        activated_by: "operator",
        activated_at: now,
      });
      if (!activated.ok) throw new Error("host not moved");
      return list(query);
    };
    expect(await publish()).toMatchObject({
      ok: false,
      refusal: {
        code: "revision_conflict",
        message: expect.stringContaining(`from ${first} to ${moved.id}`),
      },
    });
  });

  test("a Story whose crew needs a provider with no headroom is held, and publish names the observation", async () => {
    await activeHost("local", { projects: ["pod"] });
    await project("pod");
    await activeRevision(conn.db, "crew", "default", crewValue as Json);
    const avoid = await conn.db.insertUsageObservation({
      provider: "codex",
      seat: null,
      window_start: new Date("2026-11-15T13:00:00.000Z"),
      window_end: new Date("2026-11-15T18:00:00.000Z"),
      value: "80",
      coverage: "measured",
      observed_at: now,
      source: { kind: "usage record", window: "5h", pace: "avoid" },
    });
    tracker.listings = { "id-pod": [story("TPC-1")] };
    expect(await read()).toMatchObject({
      ranked: [],
      held: [{ key: "TPC-1", reason: "usage: codex", project: "pod" }],
      usage: [
        { provider: "claude", state: "unknown", observation_id: null },
        {
          provider: "codex",
          state: "held",
          value: "80",
          pace: "avoid",
          observation_id: avoid.id,
        },
      ],
    });
    expect(await publish()).toMatchObject({
      published: { inputs: { usage_observation_ids: [avoid.id] } },
    });
  });

  test("an unknown reading marks the entry, and a reset mark lifts a usage hold", async () => {
    await activeHost("local", { projects: ["pod"] });
    await project("pod");
    await activeRevision(conn.db, "crew", "default", crewValue as Json);
    await conn.db.insertUsageObservation({
      provider: "codex",
      seat: null,
      window_start: now,
      window_end: now,
      value: "100",
      coverage: "measured",
      observed_at: now,
      source: { kind: "usage record", window: "weekly", pace: "ok" },
    });
    tracker.listings = { "id-pod": [story("TPC-1")] };
    expect(await read()).toMatchObject({
      held: [{ key: "TPC-1", reason: "usage: codex" }],
    });
    const marked = await writeOverride(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now,
      request: {
        kind: "reset_available",
        harness: "codex",
        until: "2026-11-15",
      },
    });
    expect(marked).toMatchObject({ ok: true });
    const plan = await read();
    expect(plan).toMatchObject({
      held: [],
      ranked: [{ key: "TPC-1" }],
      usage: [
        { provider: "claude", state: "unknown" },
        { provider: "codex", state: "reset" },
      ],
    });
    if (!plan.ok) throw new Error("plan refused");
    expect(plan.ranked[0]?.reasons).toContain("usage unknown: claude");
  });
});
