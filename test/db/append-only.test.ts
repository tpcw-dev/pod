import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

describeDb("append-only tables", () => {
  let db: Connection;

  beforeAll(async () => {
    await resetDb();
    db = openDb();
    await db.sql`insert into config.revision (id, kind, name, schema_version, rev, scope, value, actor, reason)
      values ('r1', 'policy', 'p', 1, 1, 'global', '{}', 'operator', '')`;
    await db.sql`insert into ledger.event (type, ts, host, payload, source)
      values ('receipt', now(), 'local', '{}', '{}')`;
    await db.sql`insert into ledger.usage_observation (provider, window_start, window_end, coverage, observed_at, source)
      values ('claude', now(), now(), 'no_source', now(), '{}')`;
  });
  afterAll(() => db.close());

  for (const [table, update, remove] of [
    [
      "config.revision",
      "update config.revision set reason = 'x'",
      "delete from config.revision",
    ],
    [
      "ledger.event",
      "update ledger.event set host = 'x'",
      "delete from ledger.event",
    ],
    [
      "ledger.usage_observation",
      "update ledger.usage_observation set value = 0",
      "delete from ledger.usage_observation",
    ],
  ] as const) {
    test(`UPDATE and DELETE on ${table} raise`, async () => {
      for (const statement of [update, remove]) {
        await expect(db.sql.unsafe(statement)).rejects.toMatchObject({
          code: "P0001",
          message: expect.stringContaining(`on ${table} is not allowed`),
        });
      }
    });
  }

  test("a gate receipt changes only its sync_state, and no receipt is deleted", async () => {
    await db.sql`insert into ledger.story (provider, external_id, size, stage, dependencies, synced_at)
      values ('linear', 'S-1', 's', 'impl', '[]', now())`;
    await db.sql`insert into ledger.run (run_id, story_provider, story_external_id, host, coordinator, owner_generation, snapshot_hash, state, created_at)
      values ('run-1', 'linear', 'S-1', 'local', 'c', 1, 'h', 'active', now())`;
    await db.sql`insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, created_at)
      values ('task-1', 'run-1', 'build', 'run-1:build', 'developer', '[]', 'r1', 'delivered', now())`;
    await db.sql`insert into ledger.gate_receipt (gate_id, run_id, task_id, scope, spec_revision_id, candidate_sha, keeper, outcome, source, sync_state, created_at)
      values ('review', 'run-1', 'task-1', 'task', 'r1', 'abc', 'k', 'PASS', '{}', 'synced', now())`;
    await db.sql`update ledger.gate_receipt set sync_state = 'voided'`;
    const [row] = await db.sql<
      { sync_state: string }[]
    >`select sync_state from ledger.gate_receipt`;
    expect(row?.sync_state).toBe("voided");
    await expect(
      db.sql`update ledger.gate_receipt set outcome = 'FAIL'`,
    ).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining("may change only sync_state"),
    });
    await expect(db.sql`delete from ledger.gate_receipt`).rejects.toMatchObject(
      {
        code: "P0001",
        message: expect.stringContaining(
          "DELETE on ledger.gate_receipt is not allowed",
        ),
      },
    );
  });
});
