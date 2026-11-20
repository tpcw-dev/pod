import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { crewValue, seedConfig } from "./seed.ts";

const dir = mkdtempSync(join(tmpdir(), "pod-state-pending-"));

function pendingCount(args: string[]): number {
  const state = runCli(["state", "--json", ...args]);
  expect(state.status, state.json.error?.message).toBe(0);
  return (state.json.result as { policies: { pending_requests: number } })
    .policies.pending_requests;
}

describeDb("pod state pending requests", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    await seedConfig(conn.db);
  });

  test("pod state counts a pending host-scope request that pod brief lists", () => {
    const path = join(dir, "host-crew.yaml");
    writeFileSync(
      path,
      stringify({
        kind: "crew",
        name: "default",
        schema_version: 1,
        scope: "host",
        scope_ref: "h1",
        value: crewValue,
      }),
    );
    const applied = runCli(["config", "apply", path, "--ticket", "TRK-9"], {
      POD_SEAT: "developer",
    });
    expect(applied.status, applied.json.error?.message).toBe(0);

    const brief = runCli(["brief"]);
    expect(brief.status, brief.json.error?.message).toBe(0);
    expect(
      (brief.json.result as { pending_requests: { scope: string }[] })
        .pending_requests,
    ).toMatchObject([{ scope: "host:h1", ticket: "TRK-9" }]);

    expect(pendingCount([])).toBe(1);
    expect(pendingCount(["--project", "app"])).toBe(1);
  });
});
