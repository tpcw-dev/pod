import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { droppedMember, validatePolicy } from "../../src/core/config/policy.ts";

const defaultValue = (
  parse(readFileSync("specs/policy/default.yaml", "utf8")) as {
    value: Record<string, unknown>;
  }
).value;

type Member = { name: string; match: string[] };
const reserved = defaultValue["reserved"] as Record<string, Member[]>;
const deny = reserved["deny"] ?? [];
const needsHuman = reserved["needs_human"] ?? [];

const projectWith = (classes: Record<string, Member[]>) => ({
  ...defaultValue,
  reserved: { ...reserved, ...classes },
});

const refusedAt = (value: unknown) => {
  const refusal = validatePolicy(value, null);
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
};

test("a project policy may add needs_human and deny members and promote a global needs_human member to deny", () => {
  const spend = needsHuman.find((row) => row.name === "spend");
  expect(spend).toBeDefined();
  const project = projectWith({
    deny: [
      ...deny,
      { name: "force_push", match: ["force push"] },
      spend as Member,
    ],
    needs_human: [
      ...needsHuman.filter((row) => row.name !== "spend"),
      { name: "dns_change", match: ["dns record"] },
    ],
  });
  expect(validatePolicy(project, null)).toBeNull();
  expect(droppedMember(project, defaultValue)).toBeNull();
});

test("a project policy may not demote a global deny member to needs_human", () => {
  const forcePush = { name: "force_push", match: ["force push"] };
  const global = projectWith({ deny: [...deny, forcePush] });
  const project = projectWith({ needs_human: [...needsHuman, forcePush] });
  expect(droppedMember(project, global)).toMatchObject({
    code: "schema_invalid",
    nextSteps: ["reserved.deny"],
  });
});

test("the default policy seeds limits.digest_per_day 3 and validates", () => {
  expect(defaultValue["limits"]).toMatchObject({ digest_per_day: 3 });
  expect(validatePolicy(defaultValue, null)).toBeNull();
});

const withDigest = (digest: unknown) => ({
  ...defaultValue,
  limits: { ...(defaultValue["limits"] as object), digest_per_day: digest },
});

test.each([[1], [3], [10]])("limits.digest_per_day %j passes", (digest) => {
  expect(validatePolicy(withDigest(digest), null)).toBeNull();
});

test.each([[0], [11], ["x"], [2.5], [null]])(
  "limits.digest_per_day %j is schema_invalid",
  (digest) => {
    expect(refusedAt(withDigest(digest))).toEqual([
      "schema_invalid",
      "limits.digest_per_day",
    ]);
  },
);
