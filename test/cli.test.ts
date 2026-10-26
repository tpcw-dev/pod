import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

function run(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(
    "node_modules/.bin/tsx",
    ["src/cli/index.ts", ...args],
    {
      encoding: "utf8",
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

test("help lists the verbs sorted by name", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  const names = (
    JSON.parse(result.stdout) as { result: { verbs: { name: string }[] } }
  ).result.verbs.map((verb) => verb.name);
  expect(names).toEqual([...names].sort());
  expect(names).toEqual([
    "brief",
    "config apply",
    "config export",
    "db migrate",
    "dispatch",
    "run create",
  ]);
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
