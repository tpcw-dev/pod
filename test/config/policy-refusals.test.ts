import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { droppedMember, validatePolicy } from "../../src/core/config/policy.ts";
import { attentionOf, stallMinutes } from "../../src/core/config/limits.ts";

const defaultValue = (
  parse(readFileSync("specs/policy/default.yaml", "utf8")) as {
    value: Record<string, unknown>;
  }
).value;

type Member = { name: string; match: string[] };
const reserved = defaultValue["reserved"] as Record<string, Member[]>;
const { deny, needs_human: needsHuman } = reserved as {
  deny: Member[];
  needs_human: Member[];
};
const isSpend = (row: Member) => row.name === "spend";

const projectWith = (classes: Record<string, Member[]>) => ({
  ...defaultValue,
  reserved: { ...reserved, ...classes },
});

const refusedAt = (value: unknown) => {
  const refusal = validatePolicy(value, null);
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
};

test("a project policy may add needs_human and deny members and promote a global needs_human member to deny", () => {
  expect(needsHuman.some(isSpend)).toBe(true);
  const project = projectWith({
    deny: [
      ...deny,
      { name: "force_push", match: ["force push"] },
      ...needsHuman.filter(isSpend),
    ],
    needs_human: [
      ...needsHuman.filter((row) => !isSpend(row)),
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

test("the default policy seeds limits.usage 50 and 30 and validates", () => {
  expect(defaultValue["limits"]).toMatchObject({
    usage: { floor_percent: 50, stale_minutes: 30 },
  });
  expect(validatePolicy(defaultValue, null)).toBeNull();
});

const withUsage = (usage: unknown) => ({
  ...defaultValue,
  limits: { ...(defaultValue["limits"] as object), usage },
});

test.each([
  [{ floor_percent: 101, stale_minutes: 30 }],
  [{ floor_percent: 50, stale_minutes: 0 }],
  [{ floor_percent: 50, stale_minutes: 2.5 }],
  [{ floor_percent: 50 }],
  [{ floor_percent: 50, stale_minutes: 30, extra: 1 }],
  ["x"],
])("limits.usage %j is schema_invalid", (usage) => {
  expect(refusedAt(withUsage(usage))).toEqual([
    "schema_invalid",
    "limits.usage",
  ]);
});

test("the default policy seeds limits.stall_minutes 30 and the tick reads it", () => {
  expect(defaultValue["limits"]).toMatchObject({ stall_minutes: 30 });
  expect(stallMinutes(defaultValue)).toBe(30);
  expect(stallMinutes(withStall(45))).toBe(45);
  expect(stallMinutes(withStall(0))).toBe(30);
});

const withStall = (stall: unknown) => ({
  ...defaultValue,
  limits: { ...(defaultValue["limits"] as object), stall_minutes: stall },
});

test.each([[0], [-5], [2.5], ["30"], [null]])(
  "limits.stall_minutes %j is schema_invalid",
  (stall) => {
    expect(refusedAt(withStall(stall))).toEqual([
      "schema_invalid",
      "limits.stall_minutes",
    ]);
  },
);

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

test("the default policy seeds the packet limits 20, 2000, and 30 and validates", () => {
  expect(defaultValue["limits"]).toMatchObject({
    packet_items: 20,
    packet_words: 2000,
    packet_minutes: 30,
  });
  expect(validatePolicy(defaultValue, null)).toBeNull();
});

const withLimit = (key: string, limit: unknown) => ({
  ...defaultValue,
  limits: { ...(defaultValue["limits"] as object), [key]: limit },
});

test.each([
  ["packet_items", 1, 100, "1 to 100"],
  ["packet_words", 500, 8000, "500 to 8000"],
  ["packet_minutes", 5, 120, "5 to 120"],
])("limits.%s takes an integer from %i to %i", (key, low, high, range) => {
  expect(refusedAt(withLimit(key, low))).toBeNull();
  expect(refusedAt(withLimit(key, high))).toBeNull();
  for (const bad of [low - 1, high + 1, low + 0.5, String(low)]) {
    expect(refusedAt(withLimit(key, bad))).toEqual([
      "schema_invalid",
      `limits.${key}`,
    ]);
    expect(validatePolicy(withLimit(key, bad), null)?.message).toBe(
      `limits.${key}: must be an integer from ${range}`,
    );
  }
});

test("the default policy seeds attention 22:00 and 12 hours and validates", () => {
  expect(defaultValue["attention"]).toEqual({
    pause_at: "22:00",
    max_unattended_hours: 12,
  });
  expect(validatePolicy(defaultValue, null)).toBeNull();
  expect(attentionOf(defaultValue)).toEqual({
    pause_at: "22:00",
    max_unattended_hours: 12,
  });
});

test("a policy with no attention key has no pause", () => {
  const without = Object.fromEntries(
    Object.entries(defaultValue).filter(([key]) => key !== "attention"),
  );
  expect(validatePolicy(without, null)).toBeNull();
  expect(attentionOf(without)).toBeNull();
});

const withAttention = (attention: unknown) => ({ ...defaultValue, attention });

test.each([
  [{ pause_at: "25:00", max_unattended_hours: 12 }],
  [{ pause_at: "9:00", max_unattended_hours: 12 }],
  [{ pause_at: "22:00", max_unattended_hours: 0 }],
  [{ pause_at: "22:00", max_unattended_hours: 1.5 }],
  [{ pause_at: "22:00" }],
  [{ pause_at: "22:00", max_unattended_hours: 12, extra: 1 }],
  [null],
])("attention %j is schema_invalid", (attention) => {
  expect(refusedAt(withAttention(attention))).toEqual([
    "schema_invalid",
    "attention",
  ]);
});
