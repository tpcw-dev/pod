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
});
