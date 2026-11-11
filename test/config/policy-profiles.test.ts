import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { applyConfig } from "../../src/core/config/apply.ts";
import {
  activeProfile,
  droppedMember,
  validatePolicy,
} from "../../src/core/config/policy.ts";
import type { RevisionEnvelope } from "../../src/core/domain/config.ts";
import { effectiveReserved } from "../../src/core/domain/policy.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";

const defaultValue = (
  parse(readFileSync("specs/policy/default.yaml", "utf8")) as {
    value: Record<string, unknown>;
  }
).value;

const lifted = {
  prd_review: "decision-pair-aqa",
  design_clickthrough: "decision-pair-aqa",
};

const withProfiles = (profiles: unknown, extra: object = {}) => ({
  ...defaultValue,
  profiles,
  ...extra,
});

const refusedAt = (value: unknown) => {
  const refusal = validatePolicy(value, null);
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
};

test("the default policy defines the four profiles and validates", () => {
  expect(defaultValue["profiles"]).toEqual({
    "hands-on": { agent_activates: [], deploy_production: "needs_human" },
    standard: { agent_activates: [], deploy_production: "needs_human" },
    "hands-off": {
      agent_activates: [],
      replaces: lifted,
      deploy_production: "needs_human",
    },
    autonomous: {
      agent_activates: [],
      replaces: lifted,
      deploy_production: "agent",
    },
  });
  expect(validatePolicy(defaultValue, null)).toBeNull();
  for (const name of ["hands-on", "standard", "hands-off", "autonomous"])
    expect(
      validatePolicy({ ...defaultValue, active_profile: name }, null),
    ).toBeNull();
});

test.each(["hqa_after_deploy", "staging_review"])(
  "a profile that lifts %s is refused",
  (gate) => {
    expect(
      refusedAt(
        withProfiles({ p: { replaces: { [gate]: "decision-pair-aqa" } } }),
      ),
    ).toEqual(["schema_invalid", `profiles.p.replaces.${gate}`]);
  },
);

test.each([["human"], ["yes"], [true], [null]])(
  "deploy_production %j is refused",
  (setting) => {
    expect(
      refusedAt(withProfiles({ p: { deploy_production: setting } })),
    ).toEqual(["schema_invalid", "profiles.p.deploy_production"]);
  },
);

test("a profile key outside replaces, requires, deploy_production, and method is refused", () => {
  expect(refusedAt(withProfiles({ p: { pause_at: "deploy" } }))).toEqual([
    "schema_invalid",
    "profiles.p.pause_at",
  ]);
});

test.each([
  [{ tracker: "linear" }, "profiles.p.requires.tracker"],
  [
    { policy_revision: "rev_1", tracker: "linear" },
    "profiles.p.requires.tracker",
  ],
  [{ policy_revision: "" }, "profiles.p.requires.policy_revision"],
  [{ policy_revision: 7 }, "profiles.p.requires.policy_revision"],
  ["rev_1", "profiles.p.requires"],
])("requires %j is refused", (requires, path) => {
  expect(refusedAt(withProfiles({ p: { requires } }))).toEqual([
    "schema_invalid",
    path,
  ]);
});

test("requires names only a policy_revision", () => {
  expect(
    refusedAt(withProfiles({ p: { requires: { policy_revision: "rev_1" } } })),
  ).toBeNull();
});

test.each([
  [
    { review: "Read the diff.\nThen run the tests." },
    "profiles.p.method.review",
  ],
  [{ review: "x".repeat(201) }, "profiles.p.method.review"],
  [{ review: "" }, "profiles.p.method.review"],
  [{ review: 7 }, "profiles.p.method.review"],
  ["Read the diff.", "profiles.p.method"],
  [["Read the diff."], "profiles.p.method"],
])("method %j is refused", (method, path) => {
  expect(refusedAt(withProfiles({ p: { method } }))).toEqual([
    "schema_invalid",
    path,
  ]);
});

test("a profile method overrides any step id", () => {
  expect(
    refusedAt(
      withProfiles({ p: { method: { review: "Read the diff twice." } } }),
    ),
  ).toBeNull();
});

test("an active_profile that names an undefined profile is refused", () => {
  expect(refusedAt({ ...defaultValue, active_profile: "reckless" })).toEqual([
    "schema_invalid",
    "active_profile",
  ]);
  expect(refusedAt({ gates: {}, active_profile: "hands-on" })).toEqual([
    "schema_invalid",
    "active_profile",
  ]);
  expect(activeProfile({ ...defaultValue, active_profile: "standard" })).toBe(
    "standard",
  );
});

const needsHuman = (value: unknown) =>
  effectiveReserved(value).needs_human.map((row) => row.name);

test("effectiveReserved keeps deploy_production for needs_human and drops it for agent", () => {
  expect(needsHuman(defaultValue)).toContain("deploy_production");
  expect(
    needsHuman({ ...defaultValue, active_profile: "hands-off" }),
  ).toContain("deploy_production");
  const autonomous = needsHuman({
    ...defaultValue,
    active_profile: "autonomous",
  });
  expect(autonomous).not.toContain("deploy_production");
  expect(autonomous).toContain("spend");
});

test("droppedMember still refuses a project policy that drops a global member", () => {
  const project = {
    reserved: { needs_human: [{ name: "spend", match: ["pay"] }] },
  };
  expect(droppedMember(project, defaultValue)).toBeNull();
  const global = {
    reserved: { needs_human: [{ name: "go_live", match: ["go live"] }] },
  };
  expect(droppedMember(project, global)).toMatchObject({
    code: "schema_invalid",
    nextSteps: ["reserved.needs_human"],
  });
});

describeDb("autonomous activation", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("is gate_lift_refused naming the north star conditions", async () => {
    const envelope: RevisionEnvelope = {
      kind: "policy",
      name: "default",
      schema_version: 1,
      scope: "project",
      scope_ref: "demo",
      parent: null,
      value: { ...defaultValue, active_profile: "autonomous" },
    };
    const outcome = await applyConfig(conn.db, {
      envelope,
      actor: "tester",
      reason: "test",
      now: new Date("2026-11-08T00:00:00Z"),
      activate: { expected: null, opKey: null, host: "test" },
    });
    expect(outcome).toMatchObject({
      kind: "process_invalid",
      refusal: { code: "gate_lift_refused" },
    });
    if (outcome.kind !== "process_invalid") return;
    expect(outcome.refusal.message).toContain("active_profile autonomous");
    expect(outcome.refusal.message).toContain(
      "groom, plan, the operate loop, the gate set with its needs-human exit, and policy attention all land",
    );
    expect(outcome.refusal.message).not.toContain("method");
    expect(outcome.refusal.nextSteps.join("\n")).toContain(
      "The autonomous north star in docs/tech-spec.md",
    );
  });
});
