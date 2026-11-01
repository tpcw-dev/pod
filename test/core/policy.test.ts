import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { validatePolicy } from "../../src/core/config/policy.ts";
import {
  authorizationOf,
  budgetOf,
  parseBudget,
  reservedOf,
} from "../../src/core/domain/policy.ts";

const defaultValue = (
  parse(readFileSync("specs/policy/default.yaml", "utf8")) as {
    value: Record<string, unknown>;
  }
).value;

const names = (value: unknown) => {
  const reserved = reservedOf(value);
  return {
    deny: reserved.deny.map((row) => row.name),
    needs_human: reserved.needs_human.map((row) => row.name),
    needs_existing_authorization: reserved.needs_existing_authorization.map(
      (row) => row.name,
    ),
  };
};

test("parseBudget reads durations, counts, and integers", () => {
  expect(
    parseBudget({
      wall_clock: "1h30m",
      relaunches: 0,
      tool_calls: 40,
      context_tokens: "60k",
    }),
  ).toEqual({
    ok: true,
    budget: {
      wall_clock: 5400,
      relaunches: 0,
      tool_calls: 40,
      context_tokens: 60_000,
    },
  });
  expect(parseBudget({ wall_clock: "90m" })).toMatchObject({
    ok: true,
    budget: { wall_clock: 5400, relaunches: 2 },
  });
  expect(parseBudget({ wall_clock: 45 })).toMatchObject({
    budget: { wall_clock: 45 },
  });
  expect(parseBudget(undefined)).toEqual({
    ok: true,
    budget: {
      wall_clock: 7200,
      relaunches: 2,
      tool_calls: 40,
      context_tokens: 60_000,
    },
  });
});

test.each([
  [{ wall_clock: "2 hours" }, "wall_clock"],
  [{ wall_clock: "" }, "wall_clock"],
  [{ relaunches: -1 }, "relaunches"],
  [{ tool_calls: 1.5 }, "tool_calls"],
  [{ context_tokens: "lots" }, "context_tokens"],
])("parseBudget refuses %j at %s", (value, field) => {
  expect(parseBudget(value)).toMatchObject({ ok: false, field });
});

test("budgetOf falls back field by field for a stored budget", () => {
  expect(budgetOf({ wall_clock: "soon", tool_calls: 5 })).toEqual({
    wall_clock: 7200,
    relaunches: 2,
    tool_calls: 5,
    context_tokens: 60_000,
  });
});

test("specs/policy/default.yaml carries exactly the built-in Reserved defaults", () => {
  expect(reservedOf(defaultValue)).toEqual(reservedOf({}));
  expect(validatePolicy(defaultValue, null)).toBeNull();
});

test("reservedOf keeps every default a policy omits and merges listed terms", () => {
  const merged = reservedOf({
    reserved: {
      deny: [],
      needs_human: ["vendor_contract", { name: "spend", match: ["invoice"] }],
      needs_existing_authorization: { repo_create: "story_spec" },
    },
  });
  expect(merged.deny.map((row) => row.name)).toEqual(names({}).deny);
  expect(merged.needs_human.map((row) => row.name)).toEqual([
    ...names({}).needs_human,
    "vendor_contract",
  ]);
  expect(
    merged.needs_human.find((row) => row.name === "spend")?.match,
  ).toContain("invoice");
  expect(names({ gates: [] })).toEqual(names({}));
});

test("authorizationOf reads the Story's entry and nothing else", () => {
  const value = {
    authorizations: {
      "S-1": { authorizes: ["repo_create"] },
      "S-2": { authorizes: ["vps_ssh"], story_kind: "infrastructure" },
    },
  };
  expect(authorizationOf(value, "S-1")).toEqual({
    authorizes: ["repo_create"],
    story_kind: null,
  });
  expect(authorizationOf(value, "S-2")?.story_kind).toBe("infrastructure");
  expect(authorizationOf(value, "S-3")).toBeNull();
  expect(authorizationOf({}, "S-1")).toBeNull();
});

const refused = (value: unknown, crew: unknown = null) =>
  validatePolicy(value, crew)?.nextSteps[0];

test.each([
  [
    { gates: { review: { keeper: ["a", "b"], type: "AQA" } } },
    "gates.review.keeper",
  ],
  [{ gates: { review: { type: "AQA" } } }, "gates.review.keeper"],
  [{ gates: [{ id: "review", keeper: "", type: "AQA" }] }, "gates.0.keeper"],
  [{ limits: { decision_rounds: 4 } }, "limits.decision_rounds"],
  [{ limits: { decision_rounds: 0 } }, "limits.decision_rounds"],
  [
    { limits: { decision_budget: { wall_clock: "soon" } } },
    "limits.decision_budget.wall_clock",
  ],
  [{ reserved: { needs_human: ["Bad-Name"] } }, "reserved.needs_human.0"],
  [
    { reserved: { deny: [{ name: "x", match: "pay" }] } },
    "reserved.deny.0.match",
  ],
  [{ authorizations: ["S-1"] }, "authorizations"],
  [
    { authorizations: { "S-1": { authorizes: ["spend"] } } },
    "authorizations.S-1.authorizes.0",
  ],
  [
    {
      authorizations: {
        "S-1": { authorizes: ["vps_ssh"], story_kind: "story" },
      },
    },
    "authorizations.S-1.story_kind",
  ],
  [
    { authorizations: { "S-1": { authorizes: [], extra: 1 } } },
    "authorizations.S-1",
  ],
  [
    {
      gates: { review: { keeper: "k", type: "AQA" } },
      profiles: { p: { replaces: { hqa_after_deploy: "decision-pair-aqa" } } },
    },
    "profiles.p.replaces.hqa_after_deploy",
  ],
  [
    {
      gates: { review: { keeper: "k", type: "AQA" } },
      profiles: { p: { replaces: { prd_review: "decision-pair-aqa" } } },
    },
    "profiles.p.replaces.prd_review",
  ],
  [
    {
      gates: { prd_review: { keeper: "k", type: "HQA" } },
      profiles: { p: { replaces: { prd_review: "human" } } },
    },
    "profiles.p.replaces.prd_review",
  ],
  [{ escalate_when: "everything" }, "escalate_when"],
])("validatePolicy refuses %j at %s", (value, path) => {
  expect(validatePolicy(value, null)?.code).toBe("schema_invalid");
  expect(refused(value)).toBe(path);
});

test("an HQA keeper may not be a Seat id; an AQA keeper may", () => {
  const crew = { seats: [{ id: "rev-1" }] };
  expect(
    refused({ gates: { hqa: { keeper: "rev-1", type: "HQA" } } }, crew),
  ).toBe("gates.hqa.keeper");
  expect(
    validatePolicy({ gates: { pr: { keeper: "rev-1", type: "AQA" } } }, crew),
  ).toBeNull();
  expect(
    validatePolicy({ gates: { hqa: { keeper: "rev-1", type: "HQA" } } }, null),
  ).toBeNull();
});

test("bare Gate ids, a valid authorization, and an absent map pass", () => {
  for (const value of [
    { gates: [] },
    { gates: ["review"] },
    { steps: ["a"] },
    { authorizations: { "S-1": { authorizes: ["repo_create"] } } },
    {
      authorizations: {
        "S-2": { authorizes: ["vps_ssh"], story_kind: "infrastructure" },
      },
    },
  ])
    expect(validatePolicy(value, null)).toBeNull();
});
