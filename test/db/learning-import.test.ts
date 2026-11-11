import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { acceptImportFile } from "../../src/core/domain/learning.ts";
import { addLearning } from "../../src/core/learning/add.ts";
import {
  importLearnings,
  importOpKey,
} from "../../src/core/learning/import.ts";
import { parse } from "yaml";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";

function yaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pod-learning-import-"));
  const path = join(dir, "rows.yaml");
  writeFileSync(path, body);
  return path;
}

const rows = `- source_ref: ext-1
  kind: lead
  area: process
  text: Proposed lesson
  expected: Check the gate first.
  adoption: proposed
  theme: gates
  action_story: S-40
  project: alpha
  occurrences:
    - { story: S-3, occurred_on: 2026-10-05, reporter: retro, wording: second time, evidence_id: pr:30 }
    - { story: S-1, occurred_on: 2026-10-01, reporter: lead, wording: first time, evidence_id: pr:10 }
- source_ref: ext-2
  kind: lead
  area: impl
  text: Adopted lesson
  adoption: adopted
  occurrences:
    - { story: S-2, occurred_on: 2026-10-02, reporter: healthcheck, wording: once, evidence_id: pr:20 }
- source_ref: ext-3
  kind: lead
  area: impl
  text: Rejected lesson
  expected: reject me
  adoption: rejected
  occurrences:
    - { story: S-4, occurred_on: 2026-10-03, reporter: lead, wording: once, evidence_id: pr:40 }
`;

describeDb("learning import", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function counts() {
    const [n] = await conn.sql<
      { learnings: number; occurrences: number; events: number; ops: number }[]
    >`select
        (select count(*)::int from ledger.learning) as learnings,
        (select count(*)::int from ledger.learning_occurrence) as occurrences,
        (select count(*)::int from ledger.event where type = 'learning') as events,
        (select count(*)::int from ledger.operation) as ops`;
    return n;
  }

  test("rows with proposed and adopted adoption, theme, and occurrences import once", async () => {
    const path = yaml(rows);
    const first = runCli(["learning", "import", path]);
    expect(first.status).toBe(0);
    const imported = first.json.result?.["rows"];
    expect(imported).toMatchObject([
      { source_ref: "ext-1", replayed: false },
      { source_ref: "ext-2", replayed: false },
      { source_ref: "ext-3", replayed: false },
    ]);
    expect(await counts()).toEqual({
      learnings: 3,
      occurrences: 4,
      events: 3,
      ops: 3,
    });

    const [proposed] = await conn.sql<
      {
        id: number;
        source_story: string;
        evidence_refs: string[];
        adoption: string;
        theme: string;
        action_story: string;
        expected: string;
        project_id: string;
      }[]
    >`select * from ledger.learning where text = 'Proposed lesson'`;
    expect(proposed).toMatchObject({
      source_story: "S-1",
      evidence_refs: ["pr:30", "pr:10"],
      adoption: "proposed",
      theme: "gates",
      action_story: "S-40",
      expected: "check the gate first",
      project_id: "alpha",
    });
    const occurrences = await conn.sql<
      { story: string; occurred_on: string; reporter: string }[]
    >`select story, occurred_on::text, reporter
      from ledger.learning_occurrence where learning_id = ${proposed?.id ?? 0}
      order by id`;
    expect(occurrences.map((o) => [o.story, o.occurred_on, o.reporter])).toEqual([
      ["S-1", "2026-10-01", "lead"],
      ["S-3", "2026-10-05", "retro"],
    ]);
    const [drift] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.learning_occurrence o
      join ledger.learning l on l.id = o.learning_id
      where o.created_at <> l.adoption_at or l.created_at <> l.adoption_at`;
    expect(drift?.n).toBe(0);

    const [adopted] = await conn.sql<{ adoption: string }[]>`
      select adoption from ledger.learning where text = 'Adopted lesson'`;
    expect(adopted?.adoption).toBe("adopted");

    const [event] = await conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event
      where type = 'learning' and payload->>'source_ref' = 'ext-1'`;
    expect(event?.payload).toMatchObject({ kind: "lead", source_ref: "ext-1" });
    const ids = event?.payload["occurrence_ids"];
    expect(Array.isArray(ids) && ids.length === 2).toBe(true);
    if (Array.isArray(ids)) expect(event?.payload["occurrence_id"]).toBe(ids[0]);

    const query = runCli(["learning", "query", "--text", "Proposed"]);
    expect(query.json.result).toMatchObject({
      learnings: [{ kind: "lead", theme: "gates", action_story: "S-40", occurrences: 2 }],
    });

    const again = runCli(["learning", "import", path]);
    expect(again.status).toBe(0);
    expect(again.json.result?.["rows"]).toEqual(
      (imported as { source_ref: string; id: number }[]).map((r) => ({
        ...r,
        replayed: true,
      })),
    );
    expect(await counts()).toEqual({
      learnings: 3,
      occurrences: 4,
      events: 3,
      ops: 3,
    });
  });

  function parsedRows() {
    const accepted = acceptImportFile(parse(rows));
    if (!accepted.ok) throw new Error(accepted.issues.join("; "));
    return accepted.rows;
  }

  test("a row whose op key another import already holds is replayed and writes nothing", async () => {
    const opKey = importOpKey("ext-1");
    await conn.sql`
      insert into ledger.operation (op_key, intent, status, owner_generation, result_ref, created_at, updated_at)
      values (${opKey}, 'learning', 'done', 0, ${'{"source_ref": "ext-1", "id": 777}'}::jsonb, now(), now())`;
    const result = await importLearnings(conn.db, {
      rows: parsedRows(),
      host: "h1",
      now: () => new Date(),
    });
    expect(result).toMatchObject({
      ok: true,
      rows: [
        { source_ref: "ext-1", id: 777, replayed: true },
        { source_ref: "ext-2", replayed: false },
        { source_ref: "ext-3", replayed: false },
      ],
    });
    expect(await counts()).toMatchObject({ learnings: 2, occurrences: 2, events: 2 });
  });

  test("two overlapping imports of the same file write each row once", async () => {
    const run = () =>
      importLearnings(conn.db, {
        rows: parsedRows(),
        host: "h1",
        now: () => new Date(),
      });
    const [a, b] = await Promise.all([run(), run()]);
    if (!a.ok || !b.ok) throw new Error("import refused");
    expect(a.rows.map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
    expect(await counts()).toEqual({
      learnings: 3,
      occurrences: 4,
      events: 3,
      ops: 3,
    });
  });

  test("an imported rejected row needs two new occurrences from learning add", async () => {
    expect(runCli(["learning", "import", yaml(rows)]).status).toBe(0);
    const [row] = await conn.sql<{ id: number }[]>`
      select id from ledger.learning where text = 'Rejected lesson'`;
    const add = (ref: string) =>
      addLearning(conn.db, {
        row: {
          source_story: "S-9",
          evidence_refs: [ref],
          text: "seen again",
          adoption: "new",
          area: "impl",
          project_id: null,
          kind: "lead",
          expected: "Reject me!",
          reporter: "lead",
        },
        host: "h1",
        now: () => new Date(Date.now() + 1000),
      });
    const adoption = async () =>
      (
        await conn.sql<{ adoption: string }[]>`
          select adoption from ledger.learning where id = ${row?.id ?? 0}`
      )[0]?.adoption;
    expect((await add("pr:91")).ok).toBe(true);
    expect(await adoption()).toBe("rejected");
    expect((await add("pr:92")).ok).toBe(true);
    expect(await adoption()).toBe("new");
  });

  test("an unknown kind writes nothing", async () => {
    const result = runCli([
      "learning",
      "import",
      yaml(`${rows}- source_ref: ext-9
  kind: kind_z
  area: impl
  text: x
  adoption: new
  occurrences:
    - { story: S-1, occurred_on: 2026-10-01, reporter: lead, wording: w, evidence_id: e }
`),
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("learning_kind_unknown");
    expect(result.json.error?.message).toContain("ext-9");
    expect(await counts()).toEqual({ learnings: 0, occurrences: 0, events: 0, ops: 0 });
  });

  test("malformed files are refused with the field named and write nothing", async () => {
    const one = `- source_ref: r
  kind: lead
  area: impl
  text: t
  adoption: new
  occurrences:
    - { story: S-1, occurred_on: 2026-10-01, reporter: lead, wording: w, evidence_id: e }
`;
    const cases: [string, string, string][] = [
      ["source_ref: x\n", "schema_invalid", "rows"],
      ["[]\n", "schema_invalid", "rows"],
      ["[\n", "schema_invalid", "not valid YAML"],
      [one.replace("area: impl", "area: ops"), "schema_invalid", "rows[0].area"],
      [one.replace("adoption: new", "adoption: maybe"), "schema_invalid", "rows[0].adoption"],
      [one.replace("  text: t\n", ""), "schema_invalid", "rows[0].text"],
      [`${one}  extra: 1\n`, "schema_invalid", "rows[0].extra"],
      [one.replace("2026-10-01", "2026-13-01"), "schema_invalid", "rows[0].occurrences[0].occurred_on"],
      [one.replace("reporter: lead", "reporter: bot"), "schema_invalid", "rows[0].occurrences[0].reporter"],
      [
        one.replace(/occurrences:\n.*\n/u, "occurrences: []\n"),
        "schema_invalid",
        "rows[0].occurrences",
      ],
      [
        `${one}    - { story: S-2, occurred_on: 2026-10-02, reporter: lead, wording: w, evidence_id: e }\n`,
        "schema_invalid",
        "rows[0].occurrences[1].evidence_id",
      ],
      [`${one}${one}`, "schema_invalid", "rows[1].source_ref"],
    ];
    for (const [body, code, field] of cases) {
      const result = runCli(["learning", "import", yaml(body)]);
      expect(result.json.error?.code, body).toBe(code);
      expect(
        [result.json.error?.message, ...(result.json.error?.nextSteps ?? [])].join(" "),
        body,
      ).toContain(field);
    }
    const missing = runCli(["learning", "import", join(tmpdir(), "pod-none.yaml")]);
    expect(missing.status).toBe(2);
    expect(missing.json.error?.code).toBe("usage");
    expect(await counts()).toEqual({ learnings: 0, occurrences: 0, events: 0, ops: 0 });
  });

  test("a Seat is refused usage", async () => {
    const result = runCli(["learning", "import", yaml(rows)], {
      POD_SEAT: "developer",
    });
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("usage");
    expect(result.json.error?.nextSteps).toEqual([
      "Run pod learning import from the operator's shell",
    ]);
    expect(await counts()).toEqual({ learnings: 0, occurrences: 0, events: 0, ops: 0 });
  });
});
