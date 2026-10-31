import { readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir = "fixtures/docs/docs-section-read";
const recording = (process.env["POD_DOCS_RECORD"] ?? "") !== "";

function page(): string {
  if (!recording) return "00000000-0000-4000-8000-000000000001";
  const id = process.env["POD_DOCS_PAGE"] ?? "";
  if (id === "") throw new Error("recording needs POD_DOCS_PAGE");
  return id;
}

function env(): Record<string, string> {
  if (!recording) return { POD_DOCS_FIXTURES: dir };
  return {
    POD_DOCS_RECORD: dir,
    POD_DOCS_TOKEN: process.env["POD_DOCS_TOKEN"] ?? "",
    POD_SCRUB_DENYLIST: process.env["POD_SCRUB_DENYLIST"] ?? "",
  };
}

function read(heading: string) {
  return runCli(
    ["docs", "read", "--page", page(), "--heading", heading, "--json"],
    env(),
  );
}

describeDb("docs-section-read", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("Current milestone reads the milestone name as its first paragraph", () => {
    const result = read("Current milestone");
    expect(result.status).toBe(0);
    expect(result.json.result).toMatchObject({
      heading: "Current milestone",
      tables: [],
    });
    expect(result.json.result?.["paragraphs"]).toEqual([
      "Milestone 1: ledger and verbs",
      expect.stringMatching(/^The first milestone /),
    ]);
  });

  test("Milestones reads the table with its header and rows", () => {
    const result = read("Milestones");
    expect(result.status).toBe(0);
    const tables = result.json.result?.["tables"] as {
      header: string[];
      rows: string[][];
    }[];
    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(["Milestone", "Status"]);
    expect(tables[0]?.rows.length).toBeGreaterThanOrEqual(2);
  });

  test("a heading the page lacks is docs_section_not_found", () => {
    const result = read("Nope");
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("docs_section_not_found");
  });

  test("the reads landed as docs receipts with the page and heading and no token", async () => {
    const rows = await conn.sql<
      { verb: string; port: string; heading: string }[]
    >`
      select source->>'verb' as verb, payload->>'port' as port, payload->>'heading' as heading
      from ledger.event where type = 'receipt' and payload->>'port' = 'docs'
      order by id`;
    expect(rows.map((row) => row.heading)).toEqual([
      "Current milestone",
      "Milestones",
      "Milestones",
      "Nope",
    ]);
    expect(new Set(rows.map((row) => `${row.verb} ${row.port}`))).toEqual(
      new Set(["readSection docs"]),
    );
    const token = process.env["POD_DOCS_TOKEN"] ?? "";
    if (token !== "") {
      const [dump] = await conn.sql<{ text: string }[]>`
        select coalesce(string_agg(payload::text, ''), '') as text from ledger.event`;
      expect(dump?.text.includes(token)).toBe(false);
    }
  });

  test("the scenario holds one fixture per request", () => {
    expect(readdirSync(dir).sort()).toEqual([
      "001-readSection.json",
      "002-readSection.json",
      "003-readSection.json",
      "004-readSection.json",
    ]);
  });

  test("with no token and no fixtures the verb is docs_port_missing", () => {
    const result = runCli([
      "docs",
      "read",
      "--page",
      page(),
      "--heading",
      "Nope",
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("docs_port_missing");
    expect(result.json.error?.nextSteps).toContain(
      "set POD_DOCS_TOKEN to the docs token",
    );
  });
});
