import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string } {
  const result = spawnSync(
    "node_modules/.bin/tsx",
    ["src/cli/index.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

test("a positional is not help", () => {
  for (const args of [
    ["--help", "extra"],
    ["extra", "--help"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "usage", nextSteps: ["pod --help"] },
    });
  }
});

test("learning and docs help exit 0", () => {
  for (const args of [
    ["learning", "add", "--help"],
    ["learning", "query", "--help"],
    ["docs", "read", "--help"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  }
});

test("help lists the verbs sorted by name", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  const names = (
    JSON.parse(result.stdout) as { result: { verbs: { name: string }[] } }
  ).result.verbs.map((verb) => verb.name);
  expect(names).toEqual([...names].sort());
  expect(names).toEqual([
    "brief",
    "check",
    "config apply",
    "config export",
    "db migrate",
    "decide",
    "dispatch",
    "docs read",
    "drain",
    "hqa record",
    "learning add",
    "learning query",
    "release",
    "retry",
    "run create",
    "state",
    "takeover",
    "verdict post",
  ]);
});

test("--json on a verb that does not take it is usage", () => {
  const result = run(["learning", "query", "--json"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("usage");
});

test("a flag the verb does not take is usage", () => {
  const result = run(["db", "migrate", "--html", "out.html"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("usage");
});

test("an unknown verb is usage", () => {
  const result = run(["config", "delete"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "usage", nextSteps: ["pod --help"] },
  });
});

test("a launch lease that is not a positive whole number is usage", () => {
  for (const lease of ["0", "-5", "soon"]) {
    const result = run(["check", "--run", "run_1", "--generation", "1"], {
      POD_LAUNCH_LEASE_SECONDS: lease,
      POD_HOME: "/nonexistent",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "usage",
        message: expect.stringContaining("POD_LAUNCH_LEASE_SECONDS"),
      },
    });
  }
});
