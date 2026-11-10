import { expect, test } from "vitest";
import { parseWorktreeStatus } from "../../src/cli/git.ts";
import { composerText } from "../../src/core/run/close.ts";

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
