import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseYaml } from "../../src/cli/yaml-file.ts";
import { RevisionEnvelope } from "../../src/core/domain/config.ts";
import {
  edgeOutcomes,
  ProcessValue,
  Selector,
  type Size,
} from "../../src/core/process/schema.ts";
import {
  selectProcess,
  type ActiveProcess,
} from "../../src/core/process/select.ts";
import { validateProcess } from "../../src/core/process/validate.ts";

const names = [
  "prd",
  "design",
  "impl-small",
  "impl-medium",
  "impl-large",
  "impl-xlarge",
] as const;
type Name = (typeof names)[number];

function load(name: Name) {
  const path = `specs/process/${name}.yaml`;
  const envelope = RevisionEnvelope.parse(
    parseYaml(readFileSync(path, "utf8"), path),
  );
  expect(envelope).toMatchObject({ kind: "process", name, schema_version: 1 });
  return { envelope, value: ProcessValue.parse(envelope.value) };
}

const specs = new Map(names.map((name) => [name, load(name)]));

function spec(name: Name) {
  const found = specs.get(name);
  if (found === undefined) throw new Error(`no spec ${name}`);
  return found;
}

const policy = {
  gates: {
    audit: { keeper: "auditor", type: "AQA" },
    prd_review: { keeper: "operator", type: "HQA" },
    taste_qa: { keeper: "taste_reviewer", type: "AQA" },
    design_clickthrough: { keeper: "operator", type: "HQA" },
    plan_review: { keeper: "decision-pair", type: "AQA" },
    story_qa: { keeper: "qa", type: "AQA" },
    review: { keeper: "reviewer", type: "AQA" },
    integration_review: { keeper: "reviewer", type: "AQA" },
    merge: { keeper: "lead", type: "AQA" },
    hqa_after_deploy: { keeper: "operator", type: "HQA" },
  },
};

function crewOf(roles: readonly string[]) {
  return { seats: roles.map((role) => ({ id: `${role}-1`, roles: [role] })) };
}

const roleCases = names.flatMap((name) =>
  spec(name).value.roles.map((missing) => ({ name, missing })),
);

test.each(names)("%s validates against a crew that fills its roles", (name) => {
  const { value } = spec(name);
  expect(validateProcess(value, crewOf(value.roles), policy)).toMatchObject({
    ok: true,
  });
});

test.each(roleCases)(
  "$name is role_unfilled naming $missing against a crew without it",
  ({ name, missing }) => {
    const { value } = spec(name);
    const crew = crewOf(value.roles.filter((role) => role !== missing));
    expect(validateProcess(value, crew, policy)).toMatchObject({
      ok: false,
      refusal: {
        code: "role_unfilled",
        message: `no crew seat holds role ${missing}`,
      },
    });
  },
);

test.each(["impl-large", "impl-xlarge"] as const)(
  "%s needs reviewer seats free of developer",
  (name) => {
    const { value } = spec(name);
    const crew = {
      seats: [
        { id: "plan-1", roles: ["planner"] },
        { id: "dev-1", roles: ["developer"] },
        { id: "both-1", roles: ["developer", "reviewer"] },
      ],
    };
    expect(validateProcess(value, crew, policy)).toMatchObject({
      ok: false,
      refusal: {
        code: "reviewer_not_independent",
        message: "step review: no seat with role reviewer is free of developer",
      },
    });
    const free = {
      seats: [...crew.seats, { id: "rev-1", roles: ["reviewer"] }],
    };
    expect(validateProcess(value, free, policy)).toMatchObject({ ok: true });
  },
);

const active: ActiveProcess[] = names.map((name) => ({
  revisionId: name,
  name,
  rev: 1,
  selector: Selector.parse(spec(name).value.selector),
}));

const sizes: Size[] = ["xs", "s", "m", "l", "xl"];
const impl: Record<Size, Name> = {
  xs: "impl-small",
  s: "impl-small",
  m: "impl-medium",
  l: "impl-large",
  xl: "impl-xlarge",
};
const selectRows = sizes.flatMap((size) => [
  { stage: "prd", size, expected: "prd" },
  { stage: "design", size, expected: "design" },
  { stage: "impl", size, expected: impl[size] },
  { stage: "qa", size, expected: "selector_none" },
]);

test.each(selectRows)(
  "a $stage Story of size $size selects $expected",
  ({ stage, size, expected }) => {
    const outcome = selectProcess({
      stage,
      size,
      kickoffLine: null,
      cliProcess: null,
      activations: active,
      named: null,
    });
    expect(outcome.ok ? outcome.revisionId : outcome.code).toBe(expected);
  },
);

test("an impl Story of size m with --process impl-small@1 is selector_conflict", () => {
  expect(
    selectProcess({
      stage: "impl",
      size: "m",
      kickoffLine: null,
      cliProcess: { name: "impl-small", rev: 1 },
      activations: active,
      named: null,
    }),
  ).toEqual({ ok: false, code: "selector_conflict" });
});

function needsOf(name: Name) {
  return Object.fromEntries(
    spec(name).value.steps.map((step) => [step.id, step.needs]),
  );
}

function edgesOf(name: Name) {
  return spec(name)
    .value.edges.flatMap((edge) =>
      edgeOutcomes(edge).map(
        (on) =>
          `${edge.from} ${on} -> ${edge.to}` +
          (edge.then === undefined ? "" : ` then ${edge.then}`) +
          (edge.new_task === true ? " new_task" : ""),
      ),
    )
    .sort();
}

const worker = ["cancel", "timeout", "unknown"];

function holds(step: string, outcomes: readonly string[] = worker) {
  return outcomes.map((on) => `${step} ${on} -> hold`);
}

const shipEdges = (then: string) => [
  ...holds("deploy", ["cancel", "unknown"]),
  "deploy done -> hqa",
  `hqa FAIL -> implement then ${then} new_task`,
  "hqa PASS -> done",
  ...holds("hqa", ["cancel"]),
  "merge FAIL -> hold",
  "merge PASS -> deploy",
  ...holds("merge", ["cancel"]),
  ...holds("pr"),
  "pr done -> merge",
];

const planEdges = [
  ...holds("plan"),
  "plan done -> plan_review",
  "plan_review FAIL -> plan then plan_review new_task",
  "plan_review PASS -> implement",
  ...holds("plan_review", ["cancel"]),
];

const reviewEdges = [
  ...holds("implement"),
  "implement done -> review",
  "integration_review FAIL -> implement then review new_task",
  "integration_review PASS -> pr",
  ...holds("integration_review"),
  "review FAIL -> implement then review new_task",
  "review PASS -> integration_review",
  ...holds("review"),
];

const tail = { merge: ["pr"], deploy: ["merge"], hqa: ["deploy"] };

const shapes: { name: Name; needs: object; edges: string[] }[] = [
  {
    name: "prd",
    needs: { draft: [], audit: ["draft"], prd_review: ["audit"] },
    edges: [
      "audit FAIL -> draft then audit new_task",
      "audit PASS -> prd_review",
      ...holds("audit"),
      ...holds("draft"),
      "draft done -> audit",
      "prd_review FAIL -> draft then audit new_task",
      "prd_review PASS -> done",
      ...holds("prd_review", ["cancel"]),
    ],
  },
  {
    name: "design",
    needs: {
      design: [],
      taste_qa: ["design"],
      design_clickthrough: ["taste_qa"],
    },
    edges: [
      ...holds("design"),
      "design done -> taste_qa",
      "design_clickthrough FAIL -> design then taste_qa new_task",
      "design_clickthrough PASS -> done",
      ...holds("design_clickthrough", ["cancel"]),
      "taste_qa FAIL -> design then taste_qa new_task",
      "taste_qa PASS -> design_clickthrough",
      ...holds("taste_qa"),
    ],
  },
  {
    name: "impl-medium",
    needs: {
      plan: [],
      plan_review: ["plan"],
      implement: ["plan_review"],
      story_qa: ["implement"],
      pr: ["story_qa"],
      ...tail,
    },
    edges: [
      ...planEdges,
      ...holds("implement"),
      "implement done -> story_qa",
      "story_qa FAIL -> implement then story_qa new_task",
      "story_qa PASS -> pr",
      ...holds("story_qa"),
      ...shipEdges("story_qa"),
    ],
  },
  {
    name: "impl-large",
    needs: {
      plan: [],
      plan_review: ["plan"],
      implement: ["plan_review"],
      review: ["implement"],
      integration_review: ["review"],
      pr: ["integration_review"],
      ...tail,
    },
    edges: [...planEdges, ...reviewEdges, ...shipEdges("review")],
  },
  {
    name: "impl-xlarge",
    needs: {
      plan: [],
      implement: ["plan"],
      review: ["implement"],
      integration_review: ["review"],
      pr: ["integration_review"],
      ...tail,
    },
    edges: [
      ...holds("plan"),
      "plan agreed -> implement",
      "plan cancelled -> hold",
      ...reviewEdges,
      ...shipEdges("review"),
    ],
  },
];

describe.each(shapes)("$name", ({ name, needs, edges }) => {
  test("names each step's needs", () => {
    expect(needsOf(name)).toEqual(needs);
  });

  test("has exactly the edge table of the tech spec", () => {
    expect(edgesOf(name)).toEqual([...edges].sort());
  });
});

test.each(["impl-medium", "impl-large", "impl-xlarge"] as const)(
  "%s deploys and keeps hqa as impl-small does",
  (name) => {
    const steps = (of: Name) =>
      spec(of).value.steps.filter((step) =>
        ["merge", "deploy", "hqa"].includes(step.id),
      );
    expect(steps(name)).toEqual(steps("impl-small"));
  },
);

test("impl-large and impl-xlarge bind integration_review to the candidate SHA", () => {
  for (const name of ["impl-large", "impl-xlarge"] as const)
    expect(
      spec(name).value.steps.find((step) => step.id === "integration_review"),
    ).toMatchObject({ gate: "integration_review", binds: "candidate_sha" });
});

test("impl-xlarge plans in a Decision, with no gate and no plan_review step", () => {
  const { steps } = spec("impl-xlarge").value;
  const plan = steps.find((step) => step.id === "plan");
  expect(plan).toMatchObject({
    type: "worker",
    role: "planner",
    decision: "plan",
  });
  expect(plan?.gate).toBeUndefined();
  expect(steps.map((step) => step.id)).not.toContain("plan_review");
});
