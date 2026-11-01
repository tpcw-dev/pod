import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { singleActive } from "../../src/core/config/active.ts";
import { ok } from "../orca/temp-fixtures.ts";
import {
  applyConfig,
  cliReplay,
  implementTask,
  planTask,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";

const policyPath = "test/replay/decision-states/policy.yaml";

function autonomousPolicy(): string {
  const policy = parse(readFileSync(policyPath, "utf8")) as {
    value: { gates: Record<string, unknown> };
  };
  const value = {
    ...policy.value,
    gates: {
      ...policy.value.gates,
      prd_review: { keeper: "human", type: "HQA" },
    },
    profiles: {
      autonomous: { replaces: { prd_review: "decision-pair-aqa" } },
    },
    active_profile: "autonomous",
  };
  const path = join(mkdtempSync(join(tmpdir(), "pod-gate-lift-")), "p.yaml");
  writeFileSync(path, stringify({ ...policy, value }));
  return path;
}

describeDb("gate-lift-refused", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig([
      policyPath,
      "test/replay/decision-states/crew.yaml",
      "test/replay/decision-states/process.yaml",
    ]);
  });
  afterAll(() => conn.close());

  async function runRecord() {
    return {
      run: await conn.db.getRun("run_1"),
      snapshot: await conn.db.getSnapshot("run_1"),
      tasks: await conn.db.listTasks("run_1"),
    };
  }

  test("an autonomous profile activation is refused naming the Run with an unsettled Task, and nothing changes", async () => {
    const created = await cliReplay(
      conn,
      [
        "run",
        "create",
        "story:TRK-1",
        "--process",
        "decision-states@1",
        "--size",
        "xl",
        "--stage",
        "impl",
      ],
      [
        ok("run-create", { run: { id: "run_1" } }),
        ok("task-create", { task: { id: planTask, status: "ready" } }),
        ok("task-create", { task: { id: implementTask, status: "pending" } }),
      ],
    );
    expect(created.status, created.json.error?.message).toBe(0);
    const active = await singleActive(conn.db, "policy", "global", "");
    const before = await runRecord();
    expect(before.tasks.map((task) => task.state)).toEqual([
      "ready",
      "pending",
    ]);

    const lifted = await cliReplay(conn, [
      "config",
      "apply",
      autonomousPolicy(),
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      active?.id ?? "none",
    ]);
    expect(lifted.status).toBe(3);
    expect(lifted.json.error).toMatchObject({ code: "gate_lift_refused" });
    expect(lifted.json.error?.message).toContain("active_profile autonomous");
    expect(lifted.json.error?.message).toContain("Run run_1");

    expect((await singleActive(conn.db, "policy", "global", ""))?.id).toBe(
      active?.id,
    );
    const [stored] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from config.revision
      where kind = 'policy' and value ? 'active_profile'`;
    expect(stored?.n).toBe(0);
    expect(await runRecord()).toEqual(before);
  });
});
