import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { groomCommand, resolveAt } from "../../src/cli/groom-verbs.ts";
import { realRepoReader } from "../../src/cli/repo-reader.ts";
import { parseGroom } from "../../src/core/config/groom.ts";
import type { GitPort } from "../../src/core/ports/git.ts";
import {
  checkProposal,
  countersOf,
  defaultPoints,
  PROVED,
  prove,
  provedLine,
  type Proof,
} from "../../src/core/groom/proves.ts";

const groom = parseGroom(
  (parse(readFileSync("specs/groom/default.yaml", "utf8")) as { value: unknown })
    .value,
);

const files: Record<string, string> = {
  "src/lib.ts": [
    "export function parseThing(text: string): number {",
    "  return text.length;",
    "}",
  ].join("\n"),
  "src/use.ts": [
    'import { parseThing } from "./lib.ts";',
    'export const size = parseThing("abc");',
  ].join("\n"),
  "test/lib.test.ts": [
    'import { parseThing } from "../src/lib.ts";',
    "const fake = { parseThing: () => 0 };",
    'it("parses a thing", () => {',
    '  expect(parseThing("ab")).toBe(2);',
    "});",
    'it("prints the size", () => {',
    '  expect(String(2)).toBe("2 things");',
    "});",
  ].join("\n"),
  "docs/notes.md": "parseThing is outside proves.under\n",
};

let repo = "";
let sha = "";

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  ).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "pod-proves-"));
  git("init", "--quiet", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${text}\n`);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  sha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/use.ts"), "parseThing();\nparseThing();\n");
});

async function proof(
  checks: string[],
  extra: Partial<Parameters<typeof prove>[1]> = {},
): Promise<Proof> {
  return prove(realRepoReader, {
    repo,
    sha,
    ref: "origin/main",
    date: "2026-11-20",
    under: groom.proves.under,
    functions: ["parseThing"],
    asserts: ["2 things"],
    checks,
    files: ["src/lib.ts", "src/absent.ts"],
    timeoutMs: 200,
    ...extra,
  });
}

test("the counters read the commit, not the working tree", async () => {
  const found = await proof([]);
  expect(found.sites).toEqual([
    { path: "src/lib.ts", line: 1, kind: "definition", function: "parseThing" },
    { path: "src/use.ts", line: 1, kind: "caller", function: "parseThing" },
    { path: "src/use.ts", line: 2, kind: "caller", function: "parseThing" },
    { path: "test/lib.test.ts", line: 1, kind: "test", function: "parseThing" },
    { path: "test/lib.test.ts", line: 2, kind: "fake", function: "parseThing" },
    { path: "test/lib.test.ts", line: 4, kind: "test", function: "parseThing" },
  ]);
  expect(found.asserting).toEqual([
    { test: "test/lib.test.ts::parses a thing", matched: ["parseThing"] },
    { test: "test/lib.test.ts::prints the size", matched: ["2 things"] },
  ]);
  expect(found.helpers).toEqual([
    { path: "test/lib.test.ts", line: 1, matched: "parseThing" },
    { path: "test/lib.test.ts", line: 2, matched: "parseThing" },
  ]);
  expect(found.paths).toEqual([
    { path: "src/lib.ts", present: true },
    { path: "src/absent.ts", present: false },
  ]);
  expect(countersOf(found)).toEqual({
    callers: 2,
    fakes: 1,
    asserting: 2,
    failing: 0,
    checks: 0,
  });
});

test("a check fails, passes, writes, or times out, and only fails and missing count as failing", async () => {
  const found = await proof(["exit 1", "true", "touch made.txt", "sleep 5"]);
  expect(found.checks).toEqual([
    { command: "exit 1", state: "fails", exit: 1 },
    { command: "true", state: "passes", exit: 0 },
    { command: "touch made.txt", state: "writes", exit: 0 },
    { command: "sleep 5", state: "timeout", exit: null },
  ]);
  expect(provedLine(found)).toBe(
    "Proved: 2 callers, 1 fake, 2 asserting tests, 1/4 checks fail today, origin/main " +
      `${sha.slice(0, 7)} 2026-11-20`,
  );
  expect(
    git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree ")),
  ).toEqual([`worktree ${repo}`]);
});

test("a missing command counts as failing", async () => {
  const found = await proof(["exit 127"]);
  expect(found.checks).toEqual([
    { command: "exit 127", state: "missing", exit: 127 },
  ]);
  expect(countersOf(found)).toMatchObject({ failing: 1, checks: 1 });
});

test("the Proved line text matches the shop hook's plurals and its regex", async () => {
  const base = await proof([]);
  const line = (counts: Partial<Proof>) => provedLine({ ...base, ...counts });
  const one = line({
    sites: [base.sites[1], base.sites[4]].filter((site) => site !== undefined),
    asserting: base.asserting.slice(0, 1),
    checks: [{ command: "exit 1", state: "fails", exit: 1 }],
  });
  const none = line({ sites: [], asserting: [], checks: [] });
  expect(one).toContain(
    "Proved: 1 caller, 1 fake, 1 asserting test, 1/1 check fails today, ",
  );
  expect(none).toContain(
    "Proved: 0 callers, 0 fakes, 0 asserting tests, 0/0 checks fail today, ",
  );
  for (const text of [one, none, line({})]) expect(text).toMatch(PROVED);
});

test("default_points takes the first row whose limits hold, else split_at", () => {
  expect(defaultPoints(groom, 1, 2)).toBe(1);
  expect(defaultPoints(groom, 3, 5)).toBe(2);
  expect(defaultPoints(groom, 2, 10)).toBe(3);
  expect(defaultPoints(groom, 12, 25)).toBe(5);
  expect(defaultPoints(groom, 13, 0)).toBe(8);
});

test("the self-check refuses points off the scale, points at split_at, and a malformed Proved line", async () => {
  const base = await proof([]);
  const good = provedLine(base);
  const code = (points: number, proved = good) =>
    checkProposal(groom, { points, proved })?.code ?? null;
  expect(code(3)).toBeNull();
  expect(code(4)).toBe("points_invalid");
  expect(code(8)).toBe("split_required");
  expect(code(3, good.replace("origin/main", "origin main"))).toBe(
    "proposal_invalid",
  );
});

function gitPort(fetched: boolean, integration: string | null): GitPort {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    checkout: unused,
    integration: () => Promise.resolve(integration),
    fetch: () => Promise.resolve(fetched),
    localTip: unused,
    remoteTip: unused,
    checkedOut: unused,
    deleteLocal: unused,
    deleteRemote: unused,
  };
}

test("--at defaults to origin/<integration> after a fetch, and a failed fetch or an unset origin/HEAD refuses usage", async () => {
  const code = (git: GitPort, at?: string) =>
    resolveAt(git, realRepoReader, repo, at).then(
      () => null,
      (error: { code: string }) => error.code,
    );
  expect(await code(gitPort(false, "main"))).toBe("usage");
  expect(await code(gitPort(true, null))).toBe("usage");
  expect(await code(gitPort(true, "main"))).toBe("usage");
  expect(await code(gitPort(false, null), "no-such-ref")).toBe("usage");
  expect(await resolveAt(gitPort(false, null), realRepoReader, repo, "main")).toEqual({
    ref: "main",
    sha,
  });
});

test("the printed next step repeats every flag of the call, quoted, so a rerun replays the same op key", () => {
  expect(
    groomCommand({
      args: ["story:TPC-1"],
      points: "3",
      reason: "one design choice",
      stage: "impl",
      repo: "/r",
      at: "origin/main",
      function: ["prove", "parse.it"],
      asserts: ["2 things"],
      check: ["exit 1", "pnpm -s vitest run x.test.ts"],
      files: ["src/a.ts"],
    }),
  ).toBe(
    "pod groom story:TPC-1 --points 3 --reason 'one design choice' --stage impl --repo /r --at origin/main " +
      "--function prove --function parse.it --asserts '2 things' --check 'exit 1' " +
      "--check 'pnpm -s vitest run x.test.ts' --files src/a.ts",
  );
});
