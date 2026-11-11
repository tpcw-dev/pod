import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { revisionId } from "../../src/core/config/canonical-json.ts";
import type {
  Revision,
  RevisionEnvelope,
} from "../../src/core/domain/config.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import {
  clearDb,
  describeDb,
  openDb,
  operatorHome,
  resetDb,
  runCli,
} from "./helpers.ts";
import { operator } from "./identity-fixture.ts";

const at = new Date("2026-11-10T00:00:00.000Z");

interface Exported {
  dir: string;
  files: { ref: string; id: string; scope: string; path: string }[];
  skipped: { ref: string; id: string; scope: string; reason: string }[];
  orphans: string[];
  pruned: boolean;
  nextSteps: string[];
}

function scoped(
  e: RevisionEnvelope,
  scope: RevisionEnvelope["scope"],
  scopeRef: string,
): RevisionEnvelope {
  return { ...e, scope, scope_ref: scopeRef };
}

function fileId(path: string): string {
  return revisionId(parse(readFileSync(path, "utf8")) as RevisionEnvelope);
}

describeDb("config export --all", () => {
  let conn: Connection;
  let cwd: string;
  let home: string;
  let mirror: string;

  async function active(e: RevisionEnvelope): Promise<Revision> {
    const revision = await storeRevision(conn.db, e);
    const result = await conn.db.activate({
      scope: e.scope,
      scope_ref: e.scope_ref,
      kind: e.kind,
      name: e.name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: at,
    });
    expect(result.ok).toBe(true);
    return revision;
  }

  function exportAll(...flags: string[]): Exported {
    const result = runCli(
      ["config", "export", "--all", ...flags],
      { POD_HOME: home },
      cwd,
    );
    expect(result.status).toBe(0);
    return result.json.result as unknown as Exported;
  }

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    cwd = mkdtempSync(join(tmpdir(), "pod-export-"));
    home = operatorHome(operator);
    mirror = join(home, "mirror");
  });

  test("each scope lands under the mirror directory, never under the cwd's specs/", async () => {
    const global = await active(
      envelope("policy", "default", { gates: ["review"] }),
    );
    const project = await active(
      scoped(
        envelope("policy", "default", { gates: ["pr"] }),
        "project",
        "app",
      ),
    );
    const host = await active(
      scoped(envelope("crew", "crew", { seats: [] }), "host", "h1"),
    );
    const result = exportAll();
    expect(result.dir).toBe(mirror);
    expect(result.files).toEqual([
      {
        ref: "crew.crew@1",
        id: host.id,
        scope: "host:h1",
        path: join(mirror, "crew/host/h1/crew.yaml"),
      },
      {
        ref: "policy.default@1",
        id: global.id,
        scope: "global",
        path: join(mirror, "policy/default.yaml"),
      },
      {
        ref: "policy.default@2",
        id: project.id,
        scope: "project:app",
        path: join(mirror, "policy/project/app/default.yaml"),
      },
    ]);
    for (const file of result.files) expect(fileId(file.path)).toBe(file.id);
    expect(existsSync(join(cwd, "specs"))).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.pruned).toBe(false);
    expect(result.nextSteps).toEqual([
      `git -C ${mirror} add -A`,
      `git -C ${mirror} commit -m "pod config export --all"`,
    ]);
  });

  test("two exports of one database write the same bytes, keys in a fixed order", async () => {
    await active(
      envelope("process", "flow", { zeta: 1, alpha: { b: 2, a: [3, 1] } }),
    );
    exportAll();
    const first = readFileSync(join(mirror, "process/flow.yaml"), "utf8");
    exportAll();
    const second = readFileSync(join(mirror, "process/flow.yaml"), "utf8");
    expect(second).toBe(first);
    expect(first).toBe(
      [
        "kind: process",
        "name: flow",
        "schema_version: 1",
        "scope: global",
        'scope_ref: ""',
        "parent: null",
        "value:",
        "  alpha:",
        "    a:",
        "      - 3",
        "      - 1",
        "    b: 2",
        "  zeta: 1",
        "",
      ].join("\n"),
    );
  });

  test("a run-scope task Revision and a pending Revision are not written", async () => {
    await active(
      scoped(envelope("task", "spec", { body: "x" }), "run", "run-1"),
    );
    await storeRevision(conn.db, envelope("policy", "waiting", { gates: [] }));
    const result = exportAll();
    expect(result.files).toEqual([]);
    expect(existsSync(join(mirror, "task"))).toBe(false);
    expect(existsSync(join(mirror, "policy/waiting.yaml"))).toBe(false);
  });

  test("orphans are read from the mirror directory, and deleted only with --prune", async () => {
    await active(envelope("policy", "default", { gates: [] }));
    mkdirSync(join(mirror, "policy/project/old"), { recursive: true });
    writeFileSync(join(mirror, "policy/retired.yaml"), "kind: policy\n");
    writeFileSync(join(mirror, "policy/project/old/x.yaml"), "a: 1\n");
    writeFileSync(join(mirror, "README.md"), "notes\n");
    mkdirSync(join(cwd, "specs/policy"), { recursive: true });
    writeFileSync(join(cwd, "specs/policy/seed.yaml"), "kind: policy\n");
    const listed = exportAll();
    expect(listed.orphans).toEqual([
      join(mirror, "policy/project/old/x.yaml"),
      join(mirror, "policy/retired.yaml"),
    ]);
    expect(listed.pruned).toBe(false);
    expect(existsSync(join(mirror, "policy/retired.yaml"))).toBe(true);
    const pruned = exportAll("--prune");
    expect(pruned.orphans).toEqual(listed.orphans);
    expect(pruned.pruned).toBe(true);
    expect(existsSync(join(mirror, "policy/retired.yaml"))).toBe(false);
    expect(existsSync(join(mirror, "policy/project/old/x.yaml"))).toBe(false);
    expect(existsSync(join(mirror, "README.md"))).toBe(true);
    expect(existsSync(join(mirror, "policy/default.yaml"))).toBe(true);
    expect(existsSync(join(cwd, "specs/policy/seed.yaml"))).toBe(true);
  });

  test("an unsafe scope_ref is skipped, and the global Revision keeps its path", async () => {
    const global = await active(envelope("policy", "default", { gates: [] }));
    const unsafe = await active(
      scoped(envelope("policy", "default", { gates: ["x"] }), "project", ".."),
    );
    const result = exportAll();
    expect(result.files.map((file) => file.path)).toEqual([
      join(mirror, "policy/default.yaml"),
    ]);
    expect(result.skipped).toEqual([
      {
        ref: "policy.default@2",
        id: unsafe.id,
        scope: "project:..",
        reason: "unsafe name or scope_ref",
      },
    ]);
    expect(fileId(join(mirror, "policy/default.yaml"))).toBe(global.id);
  });

  test("mirror_dir sets the directory, a relative one under POD_HOME", async () => {
    await active(envelope("policy", "default", { gates: [] }));
    home = operatorHome(operator, "mirror_dir: out/m\n");
    expect(exportAll().files.map((file) => file.path)).toEqual([
      join(home, "out/m/policy/default.yaml"),
    ]);
    const absolute = mkdtempSync(join(tmpdir(), "pod-mirror-"));
    home = operatorHome(operator, `mirror_dir: ${absolute}\n`);
    expect(exportAll().dir).toBe(absolute);
    expect(existsSync(join(absolute, "policy/default.yaml"))).toBe(true);
  });

  test("a mirror_dir that is a file is a usage refusal", async () => {
    await active(envelope("policy", "default", { gates: [] }));
    const file = join(cwd, "not-a-dir");
    writeFileSync(file, "x\n");
    home = operatorHome(operator, `mirror_dir: ${file}\n`);
    const result = runCli(
      ["config", "export", "--all"],
      { POD_HOME: home },
      cwd,
    );
    expect(result.json.error?.code).toBe("usage");
    expect(result.json.error?.message).toBe(`${file} is not a directory`);
  });

  test("the single-ref form stays, and mixed forms are usage errors", async () => {
    const revision = await active(envelope("policy", "default", { gates: [] }));
    const out = join(cwd, "one.yaml");
    const single = runCli(
      ["config", "export", "policy.default@1", "--out", out],
      { POD_HOME: home },
      cwd,
    );
    expect(single.status).toBe(0);
    expect(single.json.result).toEqual({
      ref: "policy.default@1",
      id: revision.id,
      out,
    });
    for (const args of [
      ["config", "export", "policy.default@1", "--all"],
      ["config", "export", "--all", "--out", out],
      ["config", "export", "policy.default@1", "--out", out, "--prune"],
      ["config", "export", "policy.default@1"],
      ["config", "export"],
    ]) {
      const result = runCli(args, { POD_HOME: home }, cwd);
      expect(result.json.error?.code, args.join(" ")).toBe("usage");
    }
  });
});
