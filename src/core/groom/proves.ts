import type { GroomValue } from "../config/groom.ts";
import type { Refusal } from "../domain/outcome.ts";
import type { CheckRun, Hit, RepoReader } from "../ports/repo-reader.ts";

export type SiteKind = "caller" | "fake" | "definition" | "test";

export interface Site {
  path: string;
  line: number;
  kind: SiteKind;
  function: string;
}

export interface Asserting {
  test: string;
  matched: string[];
}

export interface Helper {
  path: string;
  line: number;
  matched: string;
}

export interface PathFact {
  path: string;
  present: boolean;
}

export interface Proof {
  ref: string;
  sha: string;
  date: string;
  sites: Site[];
  asserting: Asserting[];
  helpers: Helper[];
  checks: CheckRun[];
  paths: PathFact[];
}

export interface Counters {
  callers: number;
  fakes: number;
  asserting: number;
  failing: number;
  checks: number;
}

export interface ProveInput {
  repo: string;
  sha: string;
  ref: string;
  date: string;
  under: readonly string[];
  functions: readonly string[];
  asserts: readonly string[];
  checks: readonly string[];
  files: readonly string[];
  timeoutMs: number;
}

/** The shop hook's Proved regex, copied so a Pod proposal passes the same check. */
export const PROVED =
  /^[ \t]*[*_`]*Proved:[*_`]*[ \t]*(\d+) callers?, (\d+) fakes?, (\d+) asserting tests?, (\d+)\/(\d+) checks? fails? today, (\S+) ([0-9a-f]{7,40}) (\d{4}-\d{2}-\d{2})\b/m;

const testFile = [
  /\.test\.[^/]+$/,
  /\.spec\.[^/]+$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.[^/]+$/,
];

export function isTestFile(path: string): boolean {
  return testFile.some((pattern) => pattern.test(path));
}

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defines(text: string, name: string): boolean {
  const bare = escaped(name);
  return [
    new RegExp(
      `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\*?\\s+${bare}\\b`,
    ),
    new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${bare}\\b\\s*[=:]`),
    new RegExp(`^\\s*(async\\s+)?def\\s+${bare}\\s*\\(`),
    new RegExp(`^\\s*(export\\s+)?(abstract\\s+)?class\\s+${bare}\\b`),
    new RegExp(`^\\s*${bare}\\s*=(?!=)`),
    new RegExp(
      `^\\s*((public|private|protected|static|async)\\s+)*${bare}\\s*\\([^)]*\\)\\s*(:[^{]+)?\\{\\s*$`,
    ),
  ].some((pattern) => pattern.test(text));
}

function fakes(text: string, name: string): boolean {
  return (
    /\b(mock|spyOn|fn)\(|\bpatch(\.object)?\(/.test(text) ||
    new RegExp(`\\b${escaped(name)}\\s*:`).test(text) ||
    defines(text, name)
  );
}

export function siteKind(path: string, text: string, name: string): SiteKind {
  if (isTestFile(path)) return fakes(text, name) ? "fake" : "test";
  return defines(text, name) ? "definition" : "caller";
}

const opener = [
  /^\s*(?:it|test)(?:\.\w+)*\(\s*(["'`])(.*?)\1/,
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
];

function testName(text: string): string | null {
  for (const pattern of opener) {
    const match = pattern.exec(text);
    if (match !== null) return match[match.length - 1] ?? null;
  }
  return null;
}

/** The nearest test case that opens at or above the line, or null for a helper. */
export function enclosingTest(source: string, line: number): string | null {
  const lines = source.split("\n");
  for (let index = Math.min(line, lines.length) - 1; index >= 0; index -= 1) {
    const name = testName(lines[index] ?? "");
    if (name !== null) return name;
  }
  return null;
}

async function assertingTests(
  reader: RepoReader,
  input: ProveInput,
  hits: { path: string; line: number; matched: string }[],
): Promise<{ asserting: Asserting[]; helpers: Helper[] }> {
  const sources = new Map<string, string>();
  const tests = new Map<string, { first: [string, number]; matched: string[] }>();
  const helpers = new Map<string, Helper>();
  for (const hit of hits) {
    if (!sources.has(hit.path))
      sources.set(
        hit.path,
        (await reader.show(input.repo, input.sha, hit.path)) ?? "",
      );
    const name = enclosingTest(sources.get(hit.path) ?? "", hit.line);
    if (name === null) {
      helpers.set(`${hit.path}:${hit.line}:${hit.matched}`, hit);
      continue;
    }
    const key = `${hit.path}::${name}`;
    const entry = tests.get(key) ?? {
      first: [hit.path, hit.line] as [string, number],
      matched: [],
    };
    if (!entry.matched.includes(hit.matched)) entry.matched.push(hit.matched);
    tests.set(key, entry);
  }
  const byPlace = (a: [string, number], b: [string, number]) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1;
  return {
    asserting: [...tests.entries()]
      .sort(([, a], [, b]) => byPlace(a.first, b.first))
      .map(([test, entry]) => ({ test, matched: entry.matched })),
    helpers: [...helpers.values()].sort((a, b) =>
      byPlace([a.path, a.line], [b.path, b.line]),
    ),
  };
}

function inside(path: string): boolean {
  return (
    path !== "" && !path.startsWith("/") && !path.split("/").includes("..")
  );
}

export async function prove(
  reader: RepoReader,
  input: ProveInput,
): Promise<Proof> {
  const sites: Site[] = [];
  const hits: { path: string; line: number; matched: string }[] = [];
  const testHit = (hit: Hit, matched: string) => {
    if (isTestFile(hit.path))
      hits.push({ path: hit.path, line: hit.line, matched });
  };
  for (const fn of input.functions) {
    const name = fn.split(".").pop() ?? fn;
    for (const hit of await reader.grep(input.repo, input.sha, input.under, {
      word: name,
    })) {
      sites.push({
        path: hit.path,
        line: hit.line,
        kind: siteKind(hit.path, hit.text, name),
        function: fn,
      });
      testHit(hit, fn);
    }
  }
  for (const text of input.asserts)
    for (const hit of await reader.grep(input.repo, input.sha, input.under, {
      fixed: text,
    }))
      testHit(hit, text);
  const { asserting, helpers } = await assertingTests(reader, input, hits);
  const checks: CheckRun[] = [];
  for (const command of input.checks)
    checks.push(
      await reader.runCheck(input.repo, input.sha, command, input.timeoutMs),
    );
  const paths: PathFact[] = [];
  for (const path of input.files)
    paths.push({
      path,
      present:
        inside(path) && (await reader.exists(input.repo, input.sha, path)),
    });
  return {
    ref: input.ref,
    sha: input.sha,
    date: input.date,
    sites,
    asserting,
    helpers,
    checks,
    paths,
  };
}

export function countersOf(proof: Proof): Counters {
  const kinds = proof.sites.map((site) => site.kind);
  return {
    callers: kinds.filter((kind) => kind === "caller").length,
    fakes: kinds.filter((kind) => kind === "fake").length,
    asserting: proof.asserting.length,
    failing: proof.checks.filter(
      (run) => run.state === "fails" || run.state === "missing",
    ).length,
    checks: proof.checks.length,
  };
}

function counted(n: number, noun: string, plural: string): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

export function provedLine(proof: Proof): string {
  const c = countersOf(proof);
  const check = c.checks === 1 ? "check fails" : "checks fail";
  return (
    `Proved: ${counted(c.callers, "caller", "callers")}, ${counted(c.fakes, "fake", "fakes")}, ` +
    `${counted(c.asserting, "asserting test", "asserting tests")}, ${c.failing}/${c.checks} ${check} today, ` +
    `${proof.ref} ${proof.sha.slice(0, 7)} ${proof.date}`
  );
}

export function defaultPoints(
  groom: GroomValue,
  paths: number,
  callers: number,
): number {
  const row = groom.default_points.find(
    (limit) => paths <= limit.max_paths && callers <= limit.max_callers,
  );
  return row?.points ?? groom.split_at;
}

export function checkProposal(
  groom: GroomValue,
  proposal: { points: number; proved: string },
): Refusal | null {
  const { points } = proposal;
  if (!groom.scale.includes(points))
    return {
      code: "points_invalid",
      message: `${points} points is not on the groom scale ${groom.scale.join(", ")}`,
      nextSteps: [`pass --points as one of ${groom.scale.join(", ")}`],
    };
  if (points >= groom.split_at)
    return {
      code: "split_required",
      message: `${points} points is at or above split_at ${groom.split_at}`,
      nextSteps: [
        `split the Story into children of at most ${groom.child_max} points, then groom each child`,
      ],
    };
  const match = PROVED.exec(proposal.proved);
  if (match === null || match.index !== 0 || match[0] !== proposal.proved)
    return {
      code: "proposal_invalid",
      message: `the Proved line does not match the Proved format: ${proposal.proved}`,
      nextSteps: ["pass --at as a ref with no whitespace"],
    };
  return null;
}
