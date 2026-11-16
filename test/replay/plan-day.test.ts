import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { OverrideRequest } from "../../src/core/domain/plan.ts";
import { hostCapacity } from "../../src/core/plan/capacity.ts";
import { publishPlan, type PlanView } from "../../src/core/plan/plan.ts";
import { writeOverride } from "../../src/core/plan/write.ts";
import { fakeTracker, listedStory } from "../db/fake-tracker.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { activeRevision, processValue } from "../db/seed.ts";

const dir = "test/replay/plan-day";
const publishAt = new Date("2026-11-15T17:00:00.000Z");
const actor = "person:operator";

function fixture<T>(name: string): T {
  return parse(readFileSync(`${dir}/${name}.yaml`, "utf8")) as T;
}

interface StoryRow {
  key: string;
  priority: number;
  points: number;
  labels?: string[];
}

describeDb("plan day", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function activate(
    revision: Awaited<ReturnType<typeof storeRevision>>,
    scope: "host" | "project",
    scopeRef: string,
  ): Promise<void> {
    const activated = await conn.db.activate({
      scope,
      scope_ref: scopeRef,
      kind: revision.kind,
      name: revision.name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: publishAt,
    });
    if (!activated.ok) throw new Error(`${revision.kind} not activated`);
  }

  async function seed(): Promise<void> {
    await activate(
      await storeRevision(conn.db, {
        ...envelope("host", "local", fixture<Json>("host")),
        scope: "host",
        scope_ref: "local",
      }),
      "host",
      "local",
    );
    await activeRevision(conn.db, "process", "impl", processValue as Json);
    const crews = fixture<Record<string, Json>>("crews");
    for (const [project, crew] of Object.entries(crews)) {
      await activeRevision(conn.db, "project", project, {
        repo: `tpcw-dev/${project}`,
        category: "Meta",
        staging: false,
        tracker: { project_name: project, project_id: `id-${project}` },
      });
      await activate(
        await storeRevision(conn.db, {
          ...envelope("crew", "crew", crew),
          scope: "project",
          scope_ref: project,
        }),
        "project",
        project,
      );
    }
    for (const row of fixture<
      { provider: string; value: string; pace: string }[]
    >("usage"))
      await conn.db.insertUsageObservation({
        provider: row.provider,
        seat: null,
        window_start: new Date("2026-11-15T12:00:00.000Z"),
        window_end: new Date("2026-11-15T22:00:00.000Z"),
        value: row.value,
        coverage: "measured",
        observed_at: publishAt,
        source: { kind: "usage record", window: "5h", pace: row.pace },
      });
    for (const event of fixture<{ at: string; request: OverrideRequest }[]>(
      "events",
    )) {
      const written = await writeOverride(conn.db, {
        host: "local",
        writer: "local",
        actor,
        now: new Date(event.at),
        request: event.request,
      });
      expect(written).toMatchObject({ ok: true, replayed: false });
    }
  }

  function tracker() {
    const fake = fakeTracker();
    fake.listings = Object.fromEntries(
      Object.entries(fixture<Record<string, StoryRow[]>>("stories")).map(
        ([project, rows]) => [
          `id-${project}`,
          rows.map((row) =>
            listedStory({
              ref: { provider: "linear", external_id: row.key },
              title: row.key,
              priority: row.priority,
              points: row.points,
              labels: row.labels ?? [],
            }),
          ),
        ],
      ),
    );
    return fake;
  }

  async function publish(): Promise<PlanView> {
    const plan = await publishPlan(conn.db, {
      host: "local",
      writer: "local",
      actor,
      now: publishAt,
      sources: { tracker: tracker(), docs: null },
    });
    if (!plan.ok) throw new Error(plan.refusal.message);
    return plan;
  }

  function stable(plan: PlanView) {
    const inputs = plan.published?.inputs;
    return {
      ranked: plan.ranked,
      held: plan.held,
      host_revision: inputs?.host_revision,
      project_revisions: inputs?.project_revisions,
      tracker: inputs?.tracker,
      usage_observations: inputs?.usage_observation_ids.length,
      overrides: inputs?.overrides.length,
    };
  }

  test("a day of hold, priority, order, stretch, and reset events publishes the fixture's plan, and replays to it", async () => {
    await seed();
    const first = await publish();
    expect(first).toMatchObject(fixture<object>("published"));
    expect(first.published).toMatchObject({ replayed: false });
    expect(first.published?.inputs.usage_observation_ids).toHaveLength(2);
    expect(first.published?.inputs.overrides).toHaveLength(5);
    expect(await hostCapacity(conn.db, "local", publishAt)).toBe(
      first.capacity.slots,
    );

    const retried = await publish();
    expect(retried.published).toMatchObject({
      replayed: true,
      event_id: first.published?.event_id,
      op_key: first.published?.op_key,
    });
    expect(stable(retried)).toEqual(stable(first));

    await clearDb(conn);
    await seed();
    const fresh = await publish();
    expect(fresh.published).toMatchObject({ replayed: false });
    expect(stable(fresh)).toEqual(stable(first));
  });
});
