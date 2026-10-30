import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { stringify } from "yaml";
import { snapshotHash } from "../../src/core/config/canonical-json.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

function processFile(summary: string): string {
  return stringify({
    kind: "process",
    name: "flow",
    schema_version: 1,
    value: { ...processValue, summary },
  });
}

describeDb("a pinned Snapshot", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("an activation leaves the pinned hash unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-snapshot-"));
    const policy = await activeRevision(conn.db, "policy", "policy", {
      gates: ["pr"],
    });
    const crew = await activeRevision(conn.db, "crew", "crew", crewValue);
    const first = join(dir, "process.yaml");
    writeFileSync(first, processFile("first"));
    const applied = runCli([
      "config",
      "apply",
      first,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(applied.status).toBe(0);
    const processId = String(applied.json.result?.["id"]);
    const gateMap = { review: "crew" };
    const ids = { crew: crew.id, process: processId, policy: policy.id };
    const hash = snapshotHash(ids, gateMap);
    await conn.db.insertSnapshot({
      run_id: "run-1",
      crew_revision_id: crew.id,
      process_revision_id: processId,
      policy_revision_id: policy.id,
      effective_gate_map: gateMap,
      hash,
      pinned_at: new Date(),
    });

    const second = join(dir, "process-2.yaml");
    writeFileSync(second, processFile("second"));
    const moved = runCli([
      "config",
      "apply",
      second,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      processId,
    ]);
    expect(moved.json.result).toMatchObject({ ref: "process.flow@2" });

    const pinned = await conn.db.getSnapshot("run-1");
    expect(pinned?.hash).toBe(hash);
    expect(pinned?.process_revision_id).toBe(processId);
    expect(
      snapshotHash(
        {
          crew: pinned?.crew_revision_id ?? "",
          process: pinned?.process_revision_id ?? "",
          policy: pinned?.policy_revision_id ?? "",
        },
        pinned?.effective_gate_map,
      ),
    ).toBe(hash);
  });
});
