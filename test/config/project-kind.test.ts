import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { validateProject } from "../../src/core/config/project.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const examplePath = "specs/project/project.example.yaml";
const example = parse(readFileSync(examplePath, "utf8")) as {
  kind: string;
  name: string;
  scope: string;
  scope_ref: string;
  value: unknown;
};
const dir = mkdtempSync(join(tmpdir(), "pod-project-"));
const seat = { POD_SEAT: "developer" };
const neither = { POD_SEAT: "", POD_HOME: mkdtempSync(join(tmpdir(), "pod-")) };

function projectValue(name: string, overrides: Record<string, unknown> = {}) {
  return {
    repo: `org-a/${name}`,
    category: "Applications",
    staging: false,
    tracker: { project_name: name, project_id: `id-${name}` },
    ...overrides,
  };
}

function without(key: string) {
  const value: Record<string, unknown> = projectValue("p1");
  delete value[key];
  return value;
}

function projectFile(
  name: string,
  value: Record<string, unknown>,
  scope = "global",
  scopeRef = "",
): string {
  const path = join(dir, `${name}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(
    path,
    stringify({
      kind: "project",
      name,
      schema_version: 1,
      scope,
      scope_ref: scopeRef,
      value,
    }),
  );
  return path;
}

function refusedAt(value: unknown) {
  const refusal = validateProject(value);
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
}

test("the example project file is a global project Revision that passes the project schema", () => {
  expect(example.kind).toBe("project");
  expect(example.scope).toBe("global");
  expect(example.scope_ref).toBe("");
  expect(validateProject(example.value)).toBeNull();
});

test("an unknown category is schema_invalid naming category", () => {
  expect(refusedAt(projectValue("p1", { category: "Games" }))).toEqual([
    "schema_invalid",
    "category",
  ]);
});

test("a missing repo is schema_invalid naming repo", () => {
  expect(refusedAt(without("repo"))).toEqual(["schema_invalid", "repo"]);
});

test.each([
  [without("staging"), "staging"],
  [projectValue("p1", { repo: "p1" }), "repo"],
  [
    projectValue("p1", { tracker: { project_name: "p1", project_id: "" } }),
    "tracker.project_id",
  ],
  [projectValue("p1", { host: "box-a" }), "host"],
  [projectValue("p1", { active_profile: "standard" }), "active_profile"],
])("%j is schema_invalid naming %s", (value, path) => {
  expect(refusedAt(value)).toEqual(["schema_invalid", path]);
});

describeDb("project kind", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => clearDb(conn));

  function activate(name: string) {
    const result = runCli([
      "config",
      "apply",
      projectFile(name, projectValue(name)),
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(result.status, result.json.error?.message).toBe(0);
    return result.json.result?.["ref"] as string;
  }

  test("a project Revision off the global scope is refused naming scope", () => {
    const result = runCli([
      "config",
      "apply",
      projectFile("p1", projectValue("p1"), "project", "p1"),
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(result.json.error?.nextSteps[0]).toBe("scope");
  });

  test("a project Revision whose repo names another repo is refused naming repo", () => {
    const result = runCli([
      "config",
      "apply",
      projectFile("p1", projectValue("p1", { repo: "org-a/p2" })),
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(result.json.error?.nextSteps[0]).toBe("repo");
  });

  test("the example written by a Seat and activated by a person round-trips through config apply and config get", () => {
    const written = runCli(
      ["config", "apply", examplePath, "--ticket", "TRK-1"],
      seat,
    );
    expect(written.status, written.json.error?.message).toBe(0);
    expect(written.json.result?.["activation"]).toBeNull();
    expect(written.json.result?.["pending"]).not.toBeNull();
    const target = `project.${example.name}`;
    expect(runCli(["config", "get", target], neither).json.error?.code).toBe(
      "config_missing",
    );
    const ref = written.json.result?.["ref"] as string;
    const activated = runCli([
      "config",
      "activate",
      ref,
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(activated.status, activated.json.error?.message).toBe(0);
    const got = runCli(["config", "get", target], neither);
    expect(got.status, got.json.error?.message).toBe(0);
    expect(got.json.result).toEqual({
      ref,
      id: written.json.result?.["id"],
      scope: "global",
      scope_ref: "",
      value: example.value,
    });
  });

  test("config list prints every active project by name without an operator or a Seat", () => {
    const empty = runCli(["config", "list", "project"], neither);
    expect(empty.status, empty.json.error?.message).toBe(0);
    expect(empty.json.result).toEqual({
      kind: "project",
      scope: "global",
      scope_ref: "",
      revisions: [],
    });
    const second = activate("p2");
    const first = activate("p1");
    const listed = runCli(["config", "list", "project"], neither);
    expect(listed.status, listed.json.error?.message).toBe(0);
    expect(listed.json.result?.["revisions"]).toEqual([
      expect.objectContaining({
        ref: first,
        name: "p1",
        value: projectValue("p1"),
      }),
      expect.objectContaining({
        ref: second,
        name: "p2",
        value: projectValue("p2"),
      }),
    ]);
  });

  test("config list refuses an unknown kind and a malformed scope", () => {
    expect(
      runCli(["config", "list", "nokind"], neither).json.error?.code,
    ).toBe("usage");
    expect(
      runCli(["config", "list", "project", "--scope", "global:x"], neither)
        .json.error?.code,
    ).toBe("usage");
  });
});
