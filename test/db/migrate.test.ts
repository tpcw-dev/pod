import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { migrate } from "../../src/adapters/postgres/migrate.ts";
import { dbUrl, describeDb, openDb, resetDb, runCli } from "./helpers.ts";

function journalThrough(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), "pod-migrations-"));
  cpSync("db/migrations", folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((entry) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(path, JSON.stringify(journal));
  return folder;
}

describeDb("pod db migrate", () => {
  beforeAll(resetDb);

  test("a run after the reset's migrate applies nothing", () => {
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 9, applied: 0 } },
    });
  });

  test("a fresh database applies the whole journal, then nothing", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 9, applied: 9 },
    });
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 9, applied: 0 },
    });
  });

  test("a database at 0003 applies 0004 through 0008", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0003_learning"))).toEqual({
      kind: "ok",
      journal: 4,
      applied: 4,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 9, applied: 5 } },
    });
  });

  test("a database at 0007 applies 0008", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0007_usage_observation"))).toEqual({
      kind: "ok",
      journal: 8,
      applied: 8,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 9, applied: 1 } },
    });
  });

  test("an applied migration the journal lacks is journal_mismatch", async () => {
    const db = openDb();
    try {
      await db.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('forged', 1)`;
      const result = runCli(["db", "migrate"]);
      expect(result.status).toBe(3);
      expect(result.json.error?.code).toBe("journal_mismatch");
      expect(result.json.error?.nextSteps).toContain(
        "unknown applied migration forged",
      );
      await db.sql`delete from drizzle.__drizzle_migrations where hash = 'forged'`;
    } finally {
      await db.close();
    }
  });

  test("an unset connection variable is usage before any connection", () => {
    const result = runCli(["db", "migrate"], { POD_DB_URL: "" });
    expect(result.status).toBe(2);
    expect(result.json.error).toMatchObject({
      code: "usage",
      nextSteps: ["set POD_DB_URL to the database URL"],
    });
  });
});
