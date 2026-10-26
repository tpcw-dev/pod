import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { revisionId } from "../../src/core/config/canonical-json.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { dbUrl, describeDb, openDb, required, resetDb } from "./helpers.ts";

function onPath(command: string): boolean {
  return spawnSync(command, ["--version"]).status === 0;
}

const tools = onPath("pg_dump") && onPath("pg_restore");
if (!tools) {
  if (required)
    throw new Error(
      "POD_DB_REQUIRED=1 and pg_dump or pg_restore is not on the path",
    );
  console.log(
    "skipping backup-restore: pg_dump or pg_restore is not on the path",
  );
}

const describeRestore = tools ? describeDb : describeDb.skip;

function restoreErrorsAreIgnorable(stderr: string): boolean {
  const errors = stderr
    .split("\n")
    .filter((line) => line.startsWith("pg_restore: error:"));
  return (
    errors.length > 0 &&
    errors.every((line) =>
      line.includes(
        'unrecognized configuration parameter "transaction_timeout"',
      ),
    )
  );
}

describeRestore("backup and restore", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("every restored Revision recomputes to its id", async () => {
    const parent = await storeRevision(
      conn.db,
      envelope("policy", "policy", { gates: ["review"], limit: 1.5 }),
    );
    await storeRevision(conn.db, {
      ...envelope("policy", "policy", {
        gates: ["review", "hqa"],
        note: "日本",
      }),
      parent: parent.id,
    });
    await storeRevision(conn.db, {
      ...envelope("crew", "crew", { seats: [] }),
      scope: "project",
      scope_ref: "p1",
    });
    const dump = join(mkdtempSync(join(tmpdir(), "pod-dump-")), "config.dump");
    const dumped = spawnSync(
      "pg_dump",
      ["--schema=config", "--format=custom", `--file=${dump}`, dbUrl()],
      {
        encoding: "utf8",
      },
    );
    expect(dumped.status, dumped.stderr).toBe(0);
    await conn.sql`set client_min_messages = warning`;
    await conn.sql`drop schema config, ledger cascade`;
    const restored = spawnSync(
      "pg_restore",
      ["--no-owner", `--dbname=${dbUrl()}`, dump],
      { encoding: "utf8" },
    );
    expect(
      restored.status === 0 || restoreErrorsAreIgnorable(restored.stderr),
      restored.stderr,
    ).toBe(true);

    const rows = await conn.sql<
      { id: string }[]
    >`select id from config.revision`;
    expect(rows).toHaveLength(3);
    for (const { id } of rows) {
      const revision = await conn.db.getRevision(id);
      expect(revision && revisionId(revision)).toBe(id);
    }
    const triggers =
      await conn.sql`select 1 from pg_trigger where tgname = 'revision_append_only'`;
    expect(triggers).toHaveLength(1);
  });
});
