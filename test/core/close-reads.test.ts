import { expect, test } from "vitest";
import { parseWorktreeStatus } from "../../src/cli/git.ts";
import type { PlannedWorktree } from "../../src/core/domain/close.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Event } from "../../src/core/domain/ledger.ts";
import type {
  CodeHostPort,
  PrState,
  PrTarget,
} from "../../src/core/ports/code-host.ts";
import { composerText } from "../../src/core/run/close.ts";
import { openPrRefusal, readPrs } from "../../src/core/run/close-effects.ts";

const rule = "─".repeat(30);

test.each([
  [
    "grok empty box",
    ["  ╭────╮", "  │ ❯                │", "  ╰── Grok ─╯"],
    "",
  ],
  [
    "grok box with text",
    ["  ╭────╮", "  │ ❯ yes, take A    │", "  ╰── Grok ─╯"],
    "yes, take A",
  ],
  ["claude empty prompt", ["● done", "❯ ", rule, "Opus"], ""],
  [
    "claude prompt with text",
    ["● done", "❯ confirm the merge", rule],
    "confirm the merge",
  ],
  ["codex empty prompt", ["• done", "› ", "  gpt · 40% left"], ""],
  ["codex prompt with text", ["• done", "› ship it", "  gpt"], "ship it"],
  ["no marker", ["$ ls", "README.md"], ""],
  [
    "an earlier marker row is not the composer",
    ["❯ old question", "● answer", "❯ "],
    "",
  ],
])("composerText reads the %s", (_name, tail, expected) => {
  expect(composerText(tail)).toBe(expected);
});

test.each([
  ["in sync", "## b...origin/b", { files: [], ahead: 0 }],
  ["ahead", "## b...origin/b [ahead 2]", { files: [], ahead: 2 }],
  [
    "ahead and behind",
    "## b...origin/b [ahead 2, behind 1]",
    { files: [], ahead: 2 },
  ],
  ["behind", "## b...origin/b [behind 1]", { files: [], ahead: 0 }],
  ["no upstream", "## b", { files: [], ahead: 0 }],
  ["detached", "## HEAD (no branch)", { files: [], ahead: 0 }],
  [
    "untracked, modified, and staged entries",
    "## b...origin/b\n?? notes.txt\n M src/a.ts\nA  src/b.ts\n?? dir/c.md",
    { files: ["notes.txt", "dir/c.md"], ahead: 0 },
  ],
])("parseWorktreeStatus reads %s", (_name, text, expected) => {
  expect(parseWorktreeStatus(text)).toEqual(expected);
});

const otherUrl = "https://code.example/other/pull/882";

function prEvent(id: number, payload: Json): Event {
  return {
    id,
    type: "pr",
    ts: new Date("2026-11-26T00:00:00Z"),
    host: "host-a",
    run_id: "run_a",
    task_id: "task_a",
    dispatch_id: null,
    op_key: null,
    payload,
    source: {},
  };
}

function worktree(repo: string | null): PlannedWorktree[] {
  return [
    {
      selector: "path:/work/repo",
      path: "/work/repo",
      repo,
      branch: "feature",
      tip: "a".repeat(40),
    },
  ];
}

function pr(number: number, state: PrState["state"]): PrState {
  return {
    number,
    state,
    head_branch: "other-feature",
    head_sha: "b".repeat(40),
    merge_commit: state === "merged" ? "c".repeat(40) : null,
  };
}

function stubHost(
  answer: (target: PrTarget) => PrState | null,
): CodeHostPort & { targets: PrTarget[] } {
  const targets: PrTarget[] = [];
  return {
    targets,
    pr(target) {
      targets.push(target);
      return Promise.resolve(answer(target));
    },
    openPrs() {
      return Promise.resolve([]);
    },
  };
}

test("a pr event with a url is read by its url, not by the worktree's repository", async () => {
  const host = stubHost((target) =>
    "url" in target ? pr(882, "merged") : null,
  );
  const plan = worktree("/work/repo");
  const reads = await readPrs(
    [prEvent(1, { number: 882, url: otherUrl })],
    [],
    plan,
    host,
  );
  expect(host.targets).toEqual([{ number: 882, url: otherUrl }]);
  expect(await openPrRefusal(reads, plan, host, "again")).toBeNull();
});

test("a pr event with no url is read by its number in the worktree's repository", async () => {
  const host = stubHost(() => pr(7, "merged"));
  const reads = await readPrs(
    [prEvent(1, { number: 7, state: "open" })],
    [],
    worktree("/work/repo"),
    host,
  );
  expect(host.targets).toEqual([{ number: 7, repo: "/work/repo" }]);
  expect(reads).toEqual([
    { number: 7, url: null, repo: "/work/repo", state: pr(7, "merged") },
  ]);
});

test("a pr event with a url and no local repository is still read", async () => {
  const host = stubHost(() => pr(882, "merged"));
  const plan = worktree(null);
  const reads = await readPrs(
    [prEvent(1, { number: 882, url: otherUrl })],
    [],
    plan,
    host,
  );
  expect(reads.map((read) => read.state?.state)).toEqual(["merged"]);
  expect(await openPrRefusal(reads, plan, host, "again")).toBeNull();
});

test("an open PR read by its url still refuses open_pr", async () => {
  const host = stubHost(() => pr(882, "open"));
  const plan = worktree("/work/repo");
  const reads = await readPrs(
    [prEvent(1, { number: 882, url: otherUrl })],
    [],
    plan,
    host,
  );
  const refusal = await openPrRefusal(reads, plan, host, "again");
  expect(refusal?.code).toBe("open_pr");
  expect(refusal?.nextSteps).toContain(
    "merge or close PR #882, then run the close again",
  );
});

test("a url read whose number differs from the event's counts as unreadable", async () => {
  const host = stubHost(() => pr(883, "merged"));
  const plan = worktree("/work/repo");
  const reads = await readPrs(
    [prEvent(1, { number: 882, url: otherUrl })],
    [],
    plan,
    host,
  );
  expect(reads.map((read) => read.state)).toEqual([null]);
  const refusal = await openPrRefusal(reads, plan, host, "again");
  expect(refusal?.nextSteps).toContain(
    "PR #882: the code host could not be read",
  );
});

test("two PRs with one number in two repositories are two reads", async () => {
  const secondUrl = "https://code.example/second/pull/882";
  const host = stubHost(() => pr(882, "merged"));
  const reads = await readPrs(
    [
      prEvent(1, { number: 882, url: otherUrl }),
      prEvent(2, { number: 882, url: secondUrl }),
      prEvent(3, { number: 882, url: secondUrl }),
    ],
    [],
    worktree("/work/repo"),
    host,
  );
  expect(host.targets).toEqual([
    { number: 882, url: otherUrl },
    { number: 882, url: secondUrl },
  ]);
  expect(reads.map((read) => read.url)).toEqual([otherUrl, secondUrl]);
});
