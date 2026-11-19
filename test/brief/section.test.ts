import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { briefSections } from "../../src/cli/brief.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const at = new Date("2026-10-26T00:00:00.000Z");

describeDb("pod brief --section", () => {
  let conn: Connection;
  const fixtures = mkdtempSync(join(tmpdir(), "pod-brief-section-"));
  const env = { POD_TRACKER_FIXTURES: fixtures };

  async function active(
    row: Awaited<ReturnType<typeof storeRevision>>,
    scope: "global" | "host",
    scopeRef: string,
  ) {
    const activated = await conn.db.activate({
      scope,
      scope_ref: scopeRef,
      kind: row.kind,
      name: row.name,
      expected: null,
      revision_id: row.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: at,
    });
    if (!activated.ok) throw new Error(`${row.kind} not activated`);
  }

  async function trackerCalls(): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event
      where type = 'receipt' and payload->>'verb' = 'listStories'`;
    return row?.n ?? 0;
  }

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await active(
      await storeRevision(conn.db, {
        ...envelope("host", "local", {
          driver: "driver-a",
          manager: false,
          slots: { default: 1, max: 1 },
          reserved: {},
          hostnames: ["host-a"],
          timezone: "Africa/Abidjan",
          projects: ["planned"],
        }),
        scope: "host",
        scope_ref: "local",
      }),
      "host",
      "local",
    );
    await active(
      await storeRevision(
        conn.db,
        envelope("project", "planned", {
          repo: "owner/planned",
          category: "Meta",
          staging: false,
          tracker: { project_name: "planned", project_id: "id-planned" },
        }),
      ),
      "global",
      "",
    );
    writeFileSync(
      join(fixtures, "001-listStories.json"),
      JSON.stringify({
        method: "listStories",
        match: {
          operation: "Stories",
          variables: { project: "id-planned", status: "Pending-groom" },
        },
        status: 200,
        body: JSON.stringify({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        error: null,
        recordedAt: at.toISOString(),
      }),
    );
  });
  afterAll(() => conn.close());

  test("only the standup section reads the tracker", async () => {
    const others = briefSections.filter((name) => name !== "standup");
    const before = await trackerCalls();
    const read = runCli(
      ["brief", ...others.flatMap((name) => ["--section", name])],
      env,
    );
    expect(read.status, JSON.stringify(read.json)).toBe(0);
    expect(
      Object.keys(read.json.result ?? {})
        .filter((key) => key !== "nextSteps")
        .sort(),
    ).toEqual(["window", ...others].sort());
    expect(await trackerCalls()).toBe(before);

    const standup = runCli(["brief", "--section", "standup"], env);
    expect(standup.status, JSON.stringify(standup.json)).toBe(0);
    expect(standup.json.result).toHaveProperty("standup.groom.stories", []);
    expect(await trackerCalls()).toBe(before + 1);
  });

  test("one section prints the window and that section only", () => {
    const read = runCli(["brief", "--section", "projects"], env);
    expect(read.status, JSON.stringify(read.json)).toBe(0);
    expect(
      Object.keys(read.json.result ?? {})
        .filter((key) => key !== "nextSteps")
        .sort(),
    ).toEqual(["projects", "window"]);
  });

  test("the mirror next step comes only with the drift section", () => {
    const drift = runCli(["brief", "--section", "drift"], env);
    expect(drift.status, JSON.stringify(drift.json)).toBe(0);
    expect(drift.json.result?.["drift"]).not.toEqual([]);
    expect(drift.json.result?.["nextSteps"]).toContain(
      "pod config export --all",
    );
    const usage = runCli(["brief", "--section", "usage"], env);
    expect(usage.status, JSON.stringify(usage.json)).toBe(0);
    expect(usage.json.result?.["nextSteps"] ?? []).not.toContain(
      "pod config export --all",
    );
  });

  test("an unknown story is story_not_found with any section", () => {
    const read = runCli(["brief", "story:missing", "--section", "usage"], env);
    expect(read.status).toBe(3);
    expect(read.json.error?.code).toBe("story_not_found");
  });

  test("an unknown section is usage and names every accepted section", () => {
    const read = runCli(["brief", "--section", "bogus"], env);
    expect(read.status).toBe(2);
    expect(read.json.error?.code).toBe("usage");
    expect(read.json.error?.nextSteps).toEqual(
      briefSections.map((name) => `pod brief --section ${name}`),
    );
  });

  test("--section takes no --html and writes no file", () => {
    const html = join(fixtures, "brief.html");
    const read = runCli(
      ["brief", "--section", "projects", "--html", html],
      env,
    );
    expect(read.status).toBe(2);
    expect(read.json.error?.code).toBe("usage");
    expect(existsSync(html)).toBe(false);
  });
});
