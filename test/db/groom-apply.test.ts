import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { createRun } from "./run-fixture.ts";
import { seedConfig } from "./seed.ts";

const seedPath = "specs/groom/default.yaml";
const dir = mkdtempSync(join(tmpdir(), "pod-groom-"));
const seat = { POD_SEAT: "developer" };
const activate = [
  "--activate",
  "--scope",
  "global",
  "--expected-revision",
  "none",
];

describeDb("groom kind", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => clearDb(conn));

  test("a person's apply activates groom.default@1, and its export round-trips byte for byte", () => {
    const applied = runCli(["config", "apply", seedPath, ...activate]);
    expect(applied.status, applied.json.error?.message).toBe(0);
    expect(applied.json.result).toMatchObject({
      ref: "groom.default@1",
      created: true,
      activation: { kind: "groom", name: "default", scope: "global" },
    });
    const out = join(dir, "export.yaml");
    expect(
      runCli(["config", "export", "groom.default@1", "--out", out]).status,
    ).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(seedPath, "utf8"));
    expect(runCli(["config", "apply", out]).json.result).toMatchObject({
      id: applied.json.result?.["id"],
      rev: 1,
      created: false,
    });
    expect(
      runCli(["config", "get", "groom.default"]).json.result,
    ).toMatchObject({ value: { split_at: 8 } });
  });

  test("a Seat's apply waits as a pending request until a person activates it", () => {
    const written = runCli(
      ["config", "apply", seedPath, "--ticket", "TRK-1"],
      seat,
    );
    expect(written.status, written.json.error?.message).toBe(0);
    expect(written.json.result?.["activation"]).toBeNull();
    expect(written.json.result?.["pending"]).toMatchObject({
      comment: `config activate ${String(written.json.result?.["id"])}`,
    });
    expect(runCli(["config", "get", "groom.default"]).json.error?.code).toBe(
      "config_missing",
    );
  });

  test("a new Run's Snapshot pins no groom Revision", async () => {
    await seedConfig(conn.db);
    const applied = runCli(["config", "apply", seedPath, ...activate]);
    expect(applied.status, applied.json.error?.message).toBe(0);
    const groomId = String(applied.json.result?.["id"]);
    await createRun(conn);
    const rows = await conn.sql<
      Record<string, unknown>[]
    >`select * from config.snapshot`;
    expect(rows).toHaveLength(1);
    expect(Object.values(rows[0] ?? {})).not.toContain(groomId);
    expect(JSON.stringify(rows[0])).not.toContain("groom");
  });
});
