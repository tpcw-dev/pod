import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";

function yaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pod-learning-"));
  const path = join(dir, "learning.yaml");
  writeFileSync(path, body);
  return path;
}

const firstFile = `source_story: S-1
evidence_refs:
  - pr:1
text: keep the seam
`;

const secondFile = `source_story: S-2
evidence_refs:
  - pr:2
text: drop the port
adoption: adopted
`;

describeDb("learning add and query", () => {
  let db: Connection;

  beforeAll(async () => {
    await resetDb();
    db = openDb();
  });
  afterAll(() => db.close());

  test("add, replay, query, and the text trigger", async () => {
    const firstPath = yaml(firstFile);
    const added = runCli([
      "learning",
      "add",
      firstPath,
      "--area",
      "impl",
      "--project",
      "alpha",
    ]);
    expect(added.status).toBe(0);
    const id = added.json.result?.["id"];
    expect(typeof id).toBe("number");
    if (typeof id !== "number") throw new Error("learning id");
    expect(added.json.result).toMatchObject({ replayed: false });

    const again = runCli([
      "learning",
      "add",
      firstPath,
      "--area",
      "impl",
      "--project",
      "alpha",
    ]);
    expect(again.status).toBe(0);
    expect(again.json.result).toMatchObject({ id, replayed: true });
    const [learnings] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.learning`;
    const [events] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = 'learning'`;
    expect(learnings?.n).toBe(1);
    expect(events?.n).toBe(1);

    const second = runCli(["learning", "add", yaml(secondFile), "--area", "design"]);
    expect(second.status).toBe(0);

    expect(
      runCli(["learning", "query", "--story", "S-1"]).json.result,
    ).toMatchObject({ learnings: [{ id, source_story: "S-1" }] });
    expect(
      runCli(["learning", "query", "--adoption", "adopted"]).json.result,
    ).toMatchObject({ learnings: [{ source_story: "S-2", adoption: "adopted" }] });
    expect(
      runCli(["learning", "query", "--text", "SEAM"]).json.result,
    ).toMatchObject({ learnings: [{ id, text: "keep the seam" }] });
    expect(
      runCli(["learning", "query", "--area", "design"]).json.result,
    ).toMatchObject({ learnings: [{ source_story: "S-2", area: "design" }] });
    expect(
      runCli(["learning", "query", "--project", "alpha"]).json.result,
    ).toMatchObject({
      learnings: [{ id, project_id: "alpha" }],
    });

    await expect(
      db.sql`update ledger.learning set text = 'changed' where id = ${id}`,
    ).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining("on ledger.learning is not allowed"),
    });
  });

  test("--area ops is usage and names the allowed values", () => {
    const result = runCli([
      "learning",
      "add",
      yaml(firstFile),
      "--area",
      "ops",
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error?.message).toContain("product");
    expect(result.json.error?.message).toContain("design");
    expect(result.json.error?.message).toContain("impl");
    expect(result.json.error?.message).toContain("process");
  });
});
