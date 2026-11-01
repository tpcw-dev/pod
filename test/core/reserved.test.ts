import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { authorized, reservedCheck } from "../../src/core/decide/reserved.ts";
import { reservedOf } from "../../src/core/domain/policy.ts";

const reserved = reservedOf({});

const ask = (
  question: string,
  over: Partial<Parameters<typeof reservedCheck>[1]> = {},
) =>
  reservedCheck(reserved, {
    category: "tradeoff",
    question,
    options: ["a", "b"],
    spec: null,
    ...over,
  });

test.each([
  ["Should the plan purchase a hosted cache?", "needs_human", "spend"],
  ["Two purchases or one?", "needs_human", "spend"],
  ["Is $40 a month fine?", "needs_human", "spend"],
  ["Rotate the API key now?", "needs_human", "credentials"],
  ["Start LIVE TRADING on the account?", "deny", "live_trading"],
  [
    "Create a repository for the docs?",
    "needs_existing_authorization",
    "repo_create",
  ],
  [
    "Open an SSH session to the box?",
    "needs_existing_authorization",
    "vps_ssh",
  ],
])("%s hits %s %s", (question, kind, member) => {
  expect(ask(question)).toMatchObject({ class: kind, member });
});

test.each([
  "Is paying down debt first right?",
  "Which costume fits the demo?",
  "Which rollout should the plan use?",
  "Replace the build spec?",
])("%s hits nothing", (question) => {
  expect(ask(question)).toBeNull();
});

test("the category, the options, and the spec each hit on their own", () => {
  expect(ask("Which one?", { category: "spend" })?.member).toBe("spend");
  expect(ask("Which one?", { category: "architecture_choice" })).toBeNull();
  expect(ask("Which one?", { options: ["buy it", "build it"] })?.member).toBe(
    "spend",
  );
  expect(
    ask("Which one?", { spec: { spec: "Drop table users, then rebuild." } })
      ?.member,
  ).toBe("data_delete");
});

test("the strictest class wins", () => {
  expect(ask("Buy shares with real money?")).toMatchObject({
    class: "deny",
    member: "live_trading",
  });
  expect(ask("Buy a server and ssh in?")).toMatchObject({
    class: "needs_human",
    member: "spend",
  });
});

test("authorization follows the entry and, for vps_ssh, the infrastructure kind", () => {
  const repo = ask("Create a repository?");
  const ssh = ask("ssh into it?");
  if (repo === null || ssh === null) throw new Error("expected hits");
  expect(authorized(repo, null)).toBe(false);
  expect(
    authorized(repo, { authorizes: ["repo_create"], story_kind: null }),
  ).toBe(true);
  expect(authorized(repo, { authorizes: ["vps_ssh"], story_kind: null })).toBe(
    false,
  );
  expect(authorized(ssh, { authorizes: ["vps_ssh"], story_kind: null })).toBe(
    false,
  );
  expect(
    authorized(ssh, { authorizes: ["vps_ssh"], story_kind: "infrastructure" }),
  ).toBe(true);
});

const requestFiles = [
  "test/db/decision-fixture.ts",
  "test/db/check-decision.test.ts",
  "test/replay/decision-happy-path.test.ts",
  "test/replay/decision-fallback.test.ts",
];

function requestTexts(text: string): string[] {
  const found: string[] = [];
  const literal = /"((?:[^"\\]|\\.)*)"/g;
  for (const block of text.matchAll(
    /(?:question|options|spec)\s*[=:]\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/g,
  ))
    for (const item of (block[1] ?? "").matchAll(literal))
      found.push(item[1] ?? "");
  for (const call of text.matchAll(/taskSpec\([^,]+,\s*"((?:[^"\\]|\\.)*)"/g))
    found.push(call[1] ?? "");
  return found;
}

test("no default term hits a Decision request text of the decide and replay fixtures", () => {
  const texts = requestFiles.flatMap((path) =>
    requestTexts(readFileSync(path, "utf8")),
  );
  expect(texts.length).toBeGreaterThan(8);
  expect(texts).toContain("Which rollout should the plan use?");
  for (const text of texts)
    expect([
      text,
      ask(text, { category: "architecture_choice", options: [] }),
    ]).toEqual([text, null]);
});
