import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { validateHost } from "../../src/core/config/host.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const seedDir = "specs/host";
const seeds = readdirSync(seedDir).filter((file) => file.endsWith(".yaml"));
const dir = mkdtempSync(join(tmpdir(), "pod-host-"));
const seat = { POD_SEAT: "developer" };
const neither = { POD_SEAT: "", POD_HOME: mkdtempSync(join(tmpdir(), "pod-")) };

function hostValue(overrides: Record<string, unknown> = {}) {
  return {
    driver: "hat-a",
    hostnames: ["box-a"],
    manager: false,
    slots: { default: 2, max: 3 },
    reserved: {},
    projects: [],
    ...overrides,
  };
}

function hostFile(
  name: string,
  value: Record<string, unknown>,
  scopeRef = name,
): string {
  const path = join(dir, `${name}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(
    path,
    stringify({
      kind: "host",
      name,
      schema_version: 1,
      scope: "host",
      scope_ref: scopeRef,
      value,
    }),
  );
  return path;
}

function refusedAt(value: unknown) {
  const refusal = validateHost(value);
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
}

test("each seed under specs/host passes the host schema", () => {
  expect(seeds.length).toBeGreaterThan(0);
  for (const file of seeds) {
    const seed = parse(readFileSync(join(seedDir, file), "utf8")) as {
      kind: string;
      name: string;
      scope: string;
      scope_ref: string;
      value: unknown;
    };
    expect(seed.kind, file).toBe("host");
    expect(`${seed.name}.yaml`).toBe(file);
    expect(seed.scope).toBe("host");
    expect(seed.scope_ref).toBe(seed.name);
    expect(validateHost(seed.value), file).toBeNull();
  }
});

test("slots.default above slots.max is schema_invalid naming slots.default", () => {
  expect(refusedAt(hostValue({ slots: { default: 4, max: 3 } }))).toEqual([
    "schema_invalid",
    "slots.default",
  ]);
});

test("a reserved total above slots.max is schema_invalid naming reserved", () => {
  expect(
    refusedAt(hostValue({ reserved: { p1: 2, p2: 2 }, projects: ["p1"] })),
  ).toEqual(["schema_invalid", "reserved"]);
  expect(refusedAt(hostValue({ reserved: { p1: 3 } }))).toBeNull();
});

test.each([
  [{ decision_seat: true }, "decision_seat"],
  [{ harnesses: ["h1"], notion_harnesses: ["h2"] }, "notion_harnesses"],
  [{ projects: ["*", "p1"] }, "projects"],
  [{ projects: ["p1", "p1"] }, "projects"],
  [{ limits: { max_swap_used_pct: 101 } }, "limits.max_swap_used_pct"],
  [
    { limits: { crew_memory_max: "4 GB", crew_swap_max: "2G" } },
    "limits.crew_memory_max",
  ],
  [{ hostnames: [] }, "hostnames"],
  [{ extra: 1 }, "extra"],
])("%j is schema_invalid naming %s", (overrides, path) => {
  expect(refusedAt(hostValue(overrides))).toEqual(["schema_invalid", path]);
});

describeDb("host kind", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => clearDb(conn));

  function activate(name: string, value: Record<string, unknown>) {
    const result = runCli([
      "config",
      "apply",
      hostFile(name, value),
      "--activate",
      "--scope",
      `host:${name}`,
      "--expected-revision",
      "none",
    ]);
    expect(result.status, result.json.error?.message).toBe(0);
  }

  function apply(name: string, value: Record<string, unknown>) {
    return runCli(["config", "apply", hostFile(name, value)]);
  }

  test("a host Revision whose scope_ref differs from its name is refused naming scope_ref", () => {
    const result = runCli([
      "config",
      "apply",
      hostFile("alpha", hostValue(), "beta"),
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(result.json.error?.nextSteps[0]).toBe("scope_ref");
  });

  test('"*" or a project another active host seats is refused naming projects', () => {
    activate("alpha", hostValue({ projects: ["*"] }));
    const star = apply("beta", hostValue({ projects: ["*"] }));
    expect(star.status).toBe(2);
    expect(star.json.error?.code).toBe("schema_invalid");
    expect(star.json.error?.nextSteps[0]).toBe("projects");
    expect(star.json.error?.message).toContain("alpha");
  });

  test("a repeated project name is refused, an empty list passes, and a host keeps its own project", () => {
    activate("alpha", hostValue({ projects: ["p1"] }));
    const repeated = apply("beta", hostValue({ projects: ["p2", "p1"] }));
    expect(repeated.status).toBe(2);
    expect(repeated.json.error?.nextSteps[0]).toBe("projects");
    expect(repeated.json.error?.message).toContain("p1");
    expect(repeated.json.error?.message).toContain("alpha");
    expect(apply("beta", hostValue({ projects: [] })).status).toBe(0);
    expect(
      apply("alpha", hostValue({ projects: ["p1"], driver: "hat-b" })).status,
    ).toBe(0);
  });

  test("each seed written by a Seat and activated by a person round-trips through config get", () => {
    for (const file of seeds) {
      const path = join(seedDir, file);
      const seed = parse(readFileSync(path, "utf8")) as {
        name: string;
        value: unknown;
      };
      const written = runCli(
        ["config", "apply", path, "--ticket", "TRK-1"],
        seat,
      );
      expect(written.status, written.json.error?.message).toBe(0);
      expect(written.json.result?.["activation"]).toBeNull();
      expect(written.json.result?.["pending"]).not.toBeNull();
      const pendingGet = runCli(
        ["config", "get", `host.${seed.name}`],
        neither,
      );
      expect(pendingGet.json.error?.code).toBe("config_missing");
      const ref = written.json.result?.["ref"] as string;
      const activated = runCli([
        "config",
        "activate",
        ref,
        "--scope",
        `host:${seed.name}`,
        "--expected-revision",
        "none",
      ]);
      expect(activated.status, activated.json.error?.message).toBe(0);
      const got = runCli(["config", "get", `host.${seed.name}`], neither);
      expect(got.status, got.json.error?.message).toBe(0);
      expect(got.json.result).toEqual({
        ref,
        id: written.json.result?.["id"],
        scope: "host",
        scope_ref: seed.name,
        value: seed.value,
      });
    }
  });

  test("config get with nothing active refuses config_missing without an operator or a Seat", () => {
    const result = runCli(["config", "get", "host.alpha"], neither);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("config_missing");
    const policy = runCli(["config", "get", "policy.default"], neither);
    expect(policy.status).toBe(3);
    expect(policy.json.error?.code).toBe("config_missing");
  });

  test("config get refuses a target that is not kind.name and a malformed scope", () => {
    expect(runCli(["config", "get", "nokind"], neither).json.error?.code).toBe(
      "usage",
    );
    expect(
      runCli(["config", "get", "host.alpha", "--scope", "global:x"], neither)
        .json.error?.code,
    ).toBe("usage");
  });
});
