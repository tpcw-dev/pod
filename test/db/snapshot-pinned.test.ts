import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { snapshotHash } from "../../src/core/config/canonical-json.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";

describeDb("a pinned Snapshot", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("an activation leaves the pinned hash unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-snapshot-"));
    const first = join(dir, "process.yaml");
    writeFileSync(
      first,
      "kind: process\nname: flow\nschema_version: 1\nvalue:\n  steps: [build]\n",
    );
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
    const crew = await storeRevision(
      conn.db,
      envelope("crew", "crew", { seats: [] }),
    );
    const policy = await storeRevision(
      conn.db,
      envelope("policy", "policy", { gates: ["review"] }),
    );
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
    writeFileSync(
      second,
      "kind: process\nname: flow\nschema_version: 1\nvalue:\n  steps: [build, review]\n",
    );
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
