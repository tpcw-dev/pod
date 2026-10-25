import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

function run(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("node_modules/.bin/tsx", ["src/cli/index.ts", ...args], {
    encoding: "utf8",
  });
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
