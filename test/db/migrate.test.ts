import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { migrate } from "../../src/adapters/postgres/migrate.ts";
import { openStates } from "../../src/core/domain/decision.ts";
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
      json: { ok: true, result: { journal: 16, applied: 0 } },
    });
  });

  test("a fresh database applies the whole journal, then nothing", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 16, applied: 16 },
    });
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 16, applied: 0 },
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
      json: { ok: true, result: { journal: 16, applied: 12 } },
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
      json: { ok: true, result: { journal: 16, applied: 8 } },
    });
  });

  test("a database at 0008 applies 0009", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0008_brief_tests"))).toEqual({
      kind: "ok",
      journal: 9,
      applied: 9,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 7 } },
    });
  });

  test("a database at 0009 applies 0010, whose state list and open index match the domain", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0009_decision"))).toEqual({
      kind: "ok",
      journal: 10,
      applied: 10,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 6 } },
    });
    const conn = openDb();
    try {
      const [check] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'decision_state_check'`;
      const [index] = await conn.sql<{ def: string }[]>`
        select indexdef as def from pg_indexes where indexname = 'decision_open_task_idx'`;
      const quoted = (text: string) => `'${text}'::text`;
      for (const state of [
        "requested",
        "reserved_denied",
        "reserved_needs_human",
        "agreed",
        "needs_human",
        "cancelled",
        "superseded",
        ...openStates,
      ])
        expect(check?.def).toContain(quoted(state));
      const listed = [...(index?.def ?? "").matchAll(/'([^']+)'::text/g)].map(
        (found) => found[1],
      );
      expect(listed).toEqual(openStates);
    } finally {
      await conn.close();
    }
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
  test("a database at 0010 applies 0011, which adds the coordinator Dispatch column and lets only a Seat row carry no owner", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0010_decision_states")),
    ).toEqual({ kind: "ok", journal: 11, applied: 11 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 5 } },
    });
    const conn = openDb();
    try {
      const [column] = await conn.sql<{ nullable: string }[]>`
        select is_nullable as nullable from information_schema.columns
        where table_schema = 'ledger' and table_name = 'run' and column_name = 'coordinator_dispatch_id'`;
      expect(column?.nullable).toBe("YES");
      const [owner] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'dispatch_owner_check'`;
      expect(owner?.def).toContain("'decider'::text");
      expect(owner?.def).toContain("'auditor'::text");
    } finally {
      await conn.close();
    }
  });

  test("a database at 0011 applies 0012, which adds a nullable prompt_bytes integer to the Dispatch", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0011_coordinator_dispatch")),
    ).toEqual({ kind: "ok", journal: 12, applied: 12 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 4 } },
    });
    const conn = openDb();
    try {
      const [column] = await conn.sql<{ nullable: string; type: string }[]>`
        select is_nullable as nullable, data_type as type from information_schema.columns
        where table_schema = 'ledger' and table_name = 'dispatch' and column_name = 'prompt_bytes'`;
      expect(column).toEqual({ nullable: "YES", type: "integer" });
    } finally {
      await conn.close();
    }
  });

  test("a database at 0012 applies 0013, which adds nullable project and profile text columns to the snapshot", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0012_prompt_bytes"))).toEqual(
      { kind: "ok", journal: 13, applied: 13 },
    );
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 3 } },
    });
    const conn = openDb();
    try {
      const columns = await conn.sql<
        { name: string; nullable: string; type: string }[]
      >`
        select column_name as name, is_nullable as nullable, data_type as type
        from information_schema.columns
        where table_schema = 'config' and table_name = 'snapshot'
          and column_name in ('project', 'profile')
        order by column_name`;
      expect(columns).toEqual([
        { name: "profile", nullable: "YES", type: "text" },
        { name: "project", nullable: "YES", type: "text" },
      ]);
    } finally {
      await conn.close();
    }
  });

  test("a database at 0014 applies 0015, which adds close to the operation intents and the event types", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0014_revision_ticket")),
    ).toEqual({ kind: "ok", journal: 15, applied: 15 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 16, applied: 1 } },
    });
    const conn = openDb();
    try {
      const checks = await conn.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in ('operation_intent_check', 'event_type_check')
        order by conname`;
      expect(checks.map((row) => row.name)).toEqual([
        "event_type_check",
        "operation_intent_check",
      ]);
      for (const row of checks) expect(row.definition).toContain("'close'");
    } finally {
      await conn.close();
    }
  });
});
