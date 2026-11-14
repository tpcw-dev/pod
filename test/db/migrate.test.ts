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
      json: { ok: true, result: { journal: 24, applied: 0 } },
    });
  });

  test("a fresh database applies the whole journal, then nothing", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 24, applied: 24 },
    });
    expect(runCli(["db", "migrate"]).json).toMatchObject({
      ok: true,
      result: { journal: 24, applied: 0 },
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
      json: { ok: true, result: { journal: 24, applied: 20 } },
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
      json: { ok: true, result: { journal: 24, applied: 16 } },
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
      json: { ok: true, result: { journal: 24, applied: 15 } },
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
      json: { ok: true, result: { journal: 24, applied: 14 } },
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
      json: { ok: true, result: { journal: 24, applied: 13 } },
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
      json: { ok: true, result: { journal: 24, applied: 12 } },
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
      json: { ok: true, result: { journal: 24, applied: 11 } },
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
      json: { ok: true, result: { journal: 24, applied: 9 } },
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

  test("a database at 0015 applies 0016, which admits the config_activate intent and the activation_requested event", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0015_close"))).toEqual({
      kind: "ok",
      journal: 16,
      applied: 16,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 8 } },
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
      expect(checks[0]?.definition).toContain("'activation_requested'");
      expect(checks[1]?.definition).toContain("'config_activate'");
    } finally {
      await conn.close();
    }
  });

  test("a database at 0016 applies 0017, which admits the host kind", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0016_config_activate")),
    ).toEqual({ kind: "ok", journal: 17, applied: 17 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 7 } },
    });
    const conn = openDb();
    try {
      const [check] = await conn.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'revision_kind_check'`;
      expect(check?.definition).toContain("'host'");
    } finally {
      await conn.close();
    }
  });

  test("a database at 0020 applies 0021, which admits the project kind", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0020_digest")),
    ).toEqual({ kind: "ok", journal: 21, applied: 21 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 3 } },
    });
    const conn = openDb();
    try {
      const [check] = await conn.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'revision_kind_check'`;
      expect(check?.definition).toContain("'project'");
    } finally {
      await conn.close();
    }
  });

  test("a database at 0017 applies 0018, which backfills kind, adoption_at, and one occurrence per learning", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0017_host_kind"))).toEqual({
      kind: "ok",
      journal: 18,
      applied: 18,
    });
    const conn = openDb();
    try {
      const rows: [string, string][] = [
        ["reversed", '["b", "a"]'],
        ["single", '["pr:1"]'],
        ["empty", "[]"],
        ["object", '{"a": 1}'],
        ["number", '["a", 1]'],
      ];
      for (const [text, refs] of rows)
        await conn.sql`
          insert into ledger.learning
            (source_story, evidence_refs, text, adoption, area, created_at)
          values ('S-1', ${refs}::jsonb, ${text}, 'adopted', 'impl',
            '2026-10-01T10:00:00Z')`;
      expect(runCli(["db", "migrate"])).toMatchObject({
        status: 0,
        json: { ok: true, result: { journal: 24, applied: 6 } },
      });
      const found = await conn.sql<
        { id: number; text: string; kind: string; same: boolean; n: number; evidence_id: string; occurred_on: string }[]
      >`
        select l.id, l.text, l.kind, l.adoption_at = l.created_at as same,
          (select count(*)::int from ledger.learning_occurrence o where o.learning_id = l.id) as n,
          o.evidence_id, o.occurred_on::text as occurred_on
        from ledger.learning l
        join ledger.learning_occurrence o on o.learning_id = l.id
        order by l.id`;
      expect(
        found.map((row) => [row.text, row.kind, row.same, row.n, row.occurred_on]),
      ).toEqual(
        rows.map(([text]) => [text, "lead", true, 1, "2026-10-01"]),
      );
      expect(found.map((row) => row.evidence_id)).toEqual([
        "a b",
        "pr:1",
        ...found.slice(2).map((row) => `learning:${row.id}`),
      ]);
      const dir = mkdtempSync(join(tmpdir(), "pod-learning-"));
      const file = join(dir, "learning.yaml");
      writeFileSync(file, "source_story: S-2\nevidence_refs: [pr:9]\ntext: after\n");
      expect(
        runCli(["learning", "add", file, "--area", "impl", "--kind", "lead"]).status,
      ).toBe(0);
      const queried = runCli(["learning", "query", "--text", "object"]);
      expect(queried.json.result).toMatchObject({
        learnings: [{ text: "object", evidence_refs: [] }],
      });
    } finally {
      await conn.close();
    }
  });
  test("a database at 0018 applies 0019, whose checks admit the retro event type and op intent", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(
      await migrate(dbUrl(), journalThrough("0018_learning_kind")),
    ).toEqual({ kind: "ok", journal: 19, applied: 19 });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 5 } },
    });
    const conn = openDb();
    try {
      const [event] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'event_type_check'`;
      const [intent] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'operation_intent_check'`;
      expect(event?.def).toContain("'retro'::text");
      expect(intent?.def).toContain("'retro'::text");
    } finally {
      await conn.close();
    }
  });

  test("a database at 0019 applies 0020, which admits digest and ruling and guards a proposal once ruled", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0019_retro"))).toEqual({
      kind: "ok",
      journal: 20,
      applied: 20,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 4 } },
    });
    const conn = openDb();
    try {
      const checks = await conn.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in ('operation_intent_check', 'event_type_check')
        order by conname`;
      for (const row of checks) {
        expect(row.definition).toContain("'retro'");
        expect(row.definition).toContain("'digest'");
        expect(row.definition).toContain("'ruling'");
      }
      const [row] = await conn.sql<{ id: number }[]>`
        insert into ledger.digest_proposal
          (proposal_key, scope, posted_on, theme, text, learning_ids, evidence_refs, shown_on, created_at)
        values ('k', 'global', '2026-11-10', 't', 'x', '[1]', '[]', '2026-11-10', now())
        returning id::int as id`;
      await conn.sql`
        update ledger.digest_proposal set ruling = 'accept', ruled_at = now()
        where id = ${row?.id ?? 0}`;
      await expect(conn.sql`
        update ledger.digest_proposal set ruling = 'reject'
        where id = ${row?.id ?? 0}`).rejects.toThrow(/UPDATE on ledger.digest_proposal is not allowed/u);
      await expect(conn.sql`
        update ledger.digest_proposal set theme = 'other'
        where id = ${row?.id ?? 0}`).rejects.toThrow(/UPDATE on ledger.digest_proposal is not allowed/u);
      await expect(conn.sql`
        delete from ledger.digest_proposal`).rejects.toThrow(/DELETE on ledger.digest_proposal is not allowed/u);
      await conn.sql`
        insert into ledger.digest_proposal
          (proposal_key, scope, posted_on, theme, text, learning_ids, evidence_refs, created_at)
        values ('k', 'global', '2026-11-11', 't', 'x', '[1]', '[]', now())`;
      await expect(conn.sql`
        insert into ledger.digest_proposal
          (proposal_key, scope, posted_on, theme, text, learning_ids, evidence_refs, created_at)
        values ('k', 'global', '2026-11-11', 't', 'x', '[1]', '[]', now())`).rejects.toThrow(
        /digest_proposal_open_key_idx/u,
      );
    } finally {
      await conn.close();
    }
  });
  test("a database at 0021 applies 0022, which admits the usage intent and adds the append-only usage_record", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0021_project_kind"))).toEqual({
      kind: "ok",
      journal: 22,
      applied: 22,
    });
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 2 } },
    });
    const conn = openDb();
    try {
      const [intent] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'operation_intent_check'`;
      expect(intent?.def).toContain("'usage'::text");
      expect(intent?.def).toContain("'ruling'::text");
      const [trigger] = await conn.sql<{ n: number }[]>`
        select count(*)::int as n from pg_trigger where tgname = 'usage_record_append_only'`;
      expect(trigger?.n).toBe(1);
    } finally {
      await conn.close();
    }
  });
  test("a database at 0022 applies 0023, which admits the rate kind, pins a rate column on the snapshot, and adds the append-only dispatch_activity", async () => {
    const db = openDb();
    await db.sql`set client_min_messages = warning`;
    await db.sql`drop schema if exists config, ledger, drizzle cascade`;
    await db.close();
    expect(await migrate(dbUrl(), journalThrough("0022_usage_record"))).toEqual(
      {
        kind: "ok",
        journal: 23,
        applied: 23,
      },
    );
    expect(runCli(["db", "migrate"])).toMatchObject({
      status: 0,
      json: { ok: true, result: { journal: 24, applied: 1 } },
    });
    const conn = openDb();
    try {
      const [kind] = await conn.sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'revision_kind_check'`;
      expect(kind?.def).toContain("'rate'::text");
      const [column] = await conn.sql<{ n: number }[]>`
        select count(*)::int as n from information_schema.columns
        where table_schema = 'config' and table_name = 'snapshot' and column_name = 'rate_revision_id'`;
      expect(column?.n).toBe(1);
      const [trigger] = await conn.sql<{ n: number }[]>`
        select count(*)::int as n from pg_trigger where tgname = 'dispatch_activity_append_only'`;
      expect(trigger?.n).toBe(1);
    } finally {
      await conn.close();
    }
  });
});
