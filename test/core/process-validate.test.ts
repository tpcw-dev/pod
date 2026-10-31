import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { validateProcess } from "../../src/core/process/validate.ts";
import { crewValue, processValue } from "../db/seed.ts";

const hold = ["timeout", "cancel", "unknown"];

function base() {
  return {
    summary: "build then review",
    selector: { stage: "impl", size: ["xs", "s"] },
    roles: ["developer", "reviewer"],
    steps: [
      { id: "build", type: "worker", role: "developer" },
      {
        id: "review",
        type: "worker",
        role: "reviewer",
        needs: ["build"],
        gate: "pr",
      },
    ] as Record<string, unknown>[],
    edges: [
      { from: "build", on: "done", to: "review" },
      { from: "build", on: hold, to: "hold" },
      { from: "review", on: "PASS", to: "done" },
      { from: "review", on: "FAIL", to: "hold" },
      { from: "review", on: hold, to: "hold" },
    ] as Record<string, unknown>[],
    limits: { attempts_per_task: 3, rework_per_lineage: 3 },
    escalation: { to: "operator" },
  };
}

type Value = ReturnType<typeof base>;

function variant(edit: (value: Value) => void): Value {
  const value = base();
  edit(value);
  return value;
}

const crew = {
  seats: [
    { id: "dev", roles: ["developer"] },
    { id: "rev", roles: ["reviewer"] },
  ],
};
const policy = { gates: ["pr"] };

const impl = (
  parse(readFileSync("specs/process/impl-small.yaml", "utf8")) as {
    value: unknown;
  }
).value;
const gates = ["review", "merge", "hqa_after_deploy"];

interface Case {
  name: string;
  value: unknown;
  crew?: unknown;
  policy?: unknown;
  code: string;
  message: string;
}

function relay() {
  return variant((v) => {
    v.steps = [
      { id: "build", type: "worker", role: "developer" },
      { id: "read", type: "worker", role: "reviewer", needs: ["build"] },
      {
        id: "review",
        type: "worker",
        role: "reviewer",
        needs: ["read"],
        gate: "pr",
      },
    ];
    v.edges = [
      { from: "build", on: "done", to: "read" },
      { from: "build", on: hold, to: "hold" },
      { from: "read", on: "done", to: "review" },
      { from: "read", on: hold, to: "hold" },
      { from: "review", on: "PASS", to: "done" },
      { from: "review", on: "FAIL", to: "hold" },
      { from: "review", on: hold, to: "hold" },
    ];
  });
}

const cases: Case[] = [
  {
    name: "schema: an unknown top-level key",
    value: { ...base(), owner: "x" },
    code: "schema_invalid",
    message: "owner",
  },
  {
    name: "schema: an unknown step key",
    value: variant((v) => {
      v.steps[0] = { ...v.steps[0], deps: [] };
    }),
    code: "schema_invalid",
    message: "steps.0",
  },
  {
    name: "schema: a worker step without a role",
    value: variant((v) => {
      v.steps[0] = { id: "build", type: "worker" };
    }),
    code: "schema_invalid",
    message: "steps.0.role",
  },
  {
    name: "schema: a human_wait step with a role",
    value: variant((v) => {
      v.steps[1] = { id: "review", type: "human_wait", role: "reviewer" };
    }),
    code: "schema_invalid",
    message: "steps.1.role",
  },
  {
    name: "schema: an unknown step type",
    value: variant((v) => {
      v.steps[0] = { id: "build", type: "robot", role: "developer" };
    }),
    code: "schema_invalid",
    message: "steps.0.type",
  },
  {
    name: "schema: an empty size list",
    value: { ...base(), selector: { stage: "impl", size: [] } },
    code: "schema_invalid",
    message: "selector.size",
  },
  {
    name: "schema: an impl selector with no size",
    value: { ...base(), selector: { stage: "impl" } },
    code: "schema_invalid",
    message: "selector.size: an impl selector names at least one size",
  },
  {
    name: "schema: no steps",
    value: { ...base(), steps: [] },
    code: "schema_invalid",
    message: "steps",
  },
  {
    name: "schema: an unknown outcome",
    value: variant((v) => {
      v.edges[0] = { from: "build", on: "finished", to: "review" };
    }),
    code: "schema_invalid",
    message: "edges.0.on",
  },
  {
    name: "schema: a limit of zero",
    value: {
      ...base(),
      limits: { attempts_per_task: 0, rework_per_lineage: 3 },
    },
    code: "schema_invalid",
    message: "limits.attempts_per_task",
  },
  {
    name: "schema: a missing escalation",
    value: variant((v) => {
      delete (v as Partial<Value>).escalation;
    }),
    code: "schema_invalid",
    message: "escalation",
  },
  {
    name: "schema: a duplicate step id",
    value: variant((v) => {
      v.steps[1] = { id: "build", type: "worker", role: "reviewer" };
    }),
    code: "schema_invalid",
    message: "steps.1.id: duplicate build",
  },
  {
    name: "schema: an unknown needs step",
    value: variant((v) => {
      v.steps[1] = { ...v.steps[1], needs: ["ghost"] };
    }),
    code: "schema_invalid",
    message: "steps.1.needs.0: unknown step ghost",
  },
  {
    name: "rule 2: a step no edge or needs reaches",
    value: variant((v) => {
      v.steps.push({ id: "lonely", type: "worker", role: "developer" });
      v.edges.push(
        { from: "lonely", on: "done", to: "done" },
        { from: "lonely", on: hold, to: "hold" },
      );
    }),
    code: "schema_invalid",
    message: "steps.2: step lonely is not reachable from build",
  },
  {
    name: "rule 3: a missing outcome edge",
    value: variant((v) => {
      v.edges.splice(1, 1, {
        from: "build",
        on: ["timeout", "cancel"],
        to: "hold",
      });
    }),
    code: "schema_invalid",
    message: "edges: step build has no edge for unknown",
  },
  {
    name: "rule 3: an outcome the step does not allow",
    value: variant((v) => {
      v.edges.push({ from: "build", on: "PASS", to: "done" });
    }),
    code: "schema_invalid",
    message: "edges.5.on: step build does not allow PASS",
  },
  {
    name: "rule 3: two edges for one outcome",
    value: variant((v) => {
      v.edges.push({ from: "build", on: "done", to: "done" });
    }),
    code: "schema_invalid",
    message: "edges.5.on: step build has a second edge for done",
  },
  {
    name: "rule 4: an edge from an unknown step",
    value: variant((v) => {
      v.edges.push({ from: "ghost", on: "done", to: "done" });
    }),
    code: "schema_invalid",
    message: "edges.5.from: unknown step ghost",
  },
  {
    name: "rule 4: an edge to an unknown target",
    value: variant((v) => {
      v.edges[2] = { from: "review", on: "PASS", to: "ship" };
    }),
    code: "schema_invalid",
    message: "edges.2.to: unknown target ship",
  },
  {
    name: "rule 5: a FAIL edge to a step without new_task",
    value: variant((v) => {
      v.edges[3] = { from: "review", on: "FAIL", to: "build" };
    }),
    code: "schema_invalid",
    message: "edges.3: a FAIL edge from review targets build without new_task",
  },
  {
    name: "rule 6: a step with gate and decision",
    value: variant((v) => {
      v.steps[1] = { ...v.steps[1], decision: "plan" };
    }),
    code: "schema_invalid",
    message: "steps.1: step review has both gate and decision",
  },
  {
    name: "rule 6: a decision step that is not a worker",
    value: variant((v) => {
      v.steps[1] = {
        id: "review",
        type: "human_wait",
        needs: ["build"],
        decision: "plan",
      };
      v.edges.splice(2, 3, {
        from: "review",
        on: ["PASS", "FAIL", "cancel"],
        to: "hold",
      });
    }),
    code: "schema_invalid",
    message: "steps.1: step review has decision but is human_wait",
  },
  {
    name: "rule 6: a decision step whose cancelled edge is not hold",
    value: variant((v) => {
      v.steps[1] = {
        id: "review",
        type: "worker",
        role: "reviewer",
        needs: ["build"],
        decision: "plan",
      };
      v.edges.splice(
        2,
        3,
        { from: "review", on: "agreed", to: "done" },
        { from: "review", on: "cancelled", to: "build" },
        { from: "review", on: hold, to: "hold" },
      );
    }),
    code: "schema_invalid",
    message:
      "edges.3.to: the cancelled edge of decision step review targets build, not hold",
  },
  {
    name: "rule 7: a step role no seat holds",
    value: variant((v) => {
      v.steps[1] = { ...v.steps[1], role: "auditor" };
    }),
    code: "role_unfilled",
    message: "no crew seat holds role auditor",
  },
  {
    name: "rule 7: a listed role no seat holds",
    value: { ...base(), roles: ["developer", "reviewer", "planner"] },
    code: "role_unfilled",
    message: "no crew seat holds role planner",
  },
  {
    name: "rule 8: the only reviewer seat also develops",
    value: base(),
    crew: {
      seats: [
        { id: "dev", roles: ["developer"] },
        { id: "both", roles: ["developer", "reviewer"] },
      ],
    },
    code: "reviewer_not_independent",
    message: "step review: no seat with role reviewer is free of developer",
  },
  {
    name: "rule 8: a reviewer after a reviewer step is independent of the developer before it",
    value: relay(),
    crew: {
      seats: [
        { id: "dev", roles: ["developer"] },
        { id: "both", roles: ["developer", "reviewer"] },
      ],
    },
    code: "reviewer_not_independent",
    message: "step review: no seat with role reviewer is free of developer",
  },
  {
    name: "rule 9: a gate the policy list lacks",
    value: base(),
    policy: { gates: ["merge"] },
    code: "schema_invalid",
    message: "steps.1.gate: gate pr is not in the active policy",
  },
  {
    name: "rule 9: a gate the policy map lacks",
    value: base(),
    policy: { gates: { merge: { keeper: "lead", type: "AQA" } } },
    code: "schema_invalid",
    message: "steps.1.gate: gate pr is not in the active policy",
  },
  {
    name: "rule 9: a policy with no gates",
    value: base(),
    policy: {},
    code: "schema_invalid",
    message: "steps.1.gate: gate pr is not in the active policy",
  },
  {
    name: "impl-small: the only reviewer seat also develops",
    value: impl,
    crew: {
      seats: [
        { id: "dev", roles: ["developer"] },
        { id: "both", roles: ["developer", "reviewer"] },
      ],
    },
    policy: { gates },
    code: "reviewer_not_independent",
    message: "step review: no seat with role reviewer is free of developer",
  },
];

test.each(cases)("$name is $code", (c) => {
  const outcome = validateProcess(c.value, c.crew ?? crew, c.policy ?? policy);
  if (outcome.ok) throw new Error("validateProcess accepted the value");
  expect(outcome.refusal.code).toBe(c.code);
  expect(outcome.refusal.message).toContain(c.message);
  expect(outcome.refusal.nextSteps).toHaveLength(1);
});

test("the base value passes against a two-seat crew", () => {
  expect(validateProcess(base(), crew, policy)).toMatchObject({ ok: true });
});

test("a size-less selector passes on a non-impl stage", () => {
  const value = { ...base(), selector: { stage: "prd" } };
  expect(validateProcess(value, crew, policy)).toMatchObject({ ok: true });
});

test("a reviewer step that needs a reviewer step passes with a free reviewer seat", () => {
  expect(validateProcess(relay(), crew, policy)).toMatchObject({ ok: true });
});

test("policy gates read as a list of ids, a list of objects, or a map", () => {
  for (const gates of [
    ["pr"],
    [{ id: "pr" }],
    { pr: { keeper: "lead", type: "AQA" } },
  ])
    expect(validateProcess(base(), crew, { gates })).toMatchObject({
      ok: true,
    });
});

test("impl-small passes against a two-seat crew and a three-gate policy", () => {
  expect(validateProcess(impl, crew, { gates })).toMatchObject({ ok: true });
  expect(
    validateProcess(impl, crew, {
      gates: Object.fromEntries(
        gates.map((id) => [id, { keeper: "k", type: "AQA" }]),
      ),
    }),
  ).toMatchObject({ ok: true });
});

test("the seed process passes against the seed crew and policy", () => {
  expect(validateProcess(processValue, crewValue, policy)).toMatchObject({
    ok: true,
  });
});

test("a FAIL edge with new_task may target a step", () => {
  const value = variant((v) => {
    v.edges[3] = {
      from: "review",
      on: "FAIL",
      to: "build",
      new_task: true,
      then: "review",
    };
  });
  expect(validateProcess(value, crew, policy)).toMatchObject({ ok: true });
});
