import { expect, test } from "vitest";
import {
  readSteps,
  StepsInvalid,
  topoOrder,
} from "../../src/core/run/steps.ts";

function value(steps: unknown): unknown {
  return {
    summary: "steps",
    selector: { stage: "impl", size: ["s"] },
    roles: [],
    steps,
    edges: [],
    limits: { attempts_per_task: 3, rework_per_lineage: 3 },
    escalation: { to: "operator" },
  };
}

function issue(steps: unknown): string {
  try {
    readSteps(value(steps));
  } catch (error) {
    if (error instanceof StepsInvalid) return error.path;
    throw error;
  }
  throw new Error("readSteps accepted the value");
}

test("steps come out in needs order, ready without needs and pending with them", () => {
  const steps = readSteps(
    value([
      {
        id: "review",
        type: "worker",
        role: "reviewer",
        needs: ["build"],
        gate: "pr",
      },
      { id: "build", type: "worker", role: "developer", spec: "Build it." },
      { id: "plan", type: "worker", role: "developer", decision: "plan" },
    ]),
  );
  const ordered = topoOrder(steps);
  expect(ordered.map((step) => step.id)).toEqual(["build", "plan", "review"]);
  expect(
    ordered.map((step) => (step.needs.length === 0 ? "ready" : "pending")),
  ).toEqual(["ready", "ready", "pending"]);
  expect(ordered[0]?.spec).toBe("Build it.");
});

test("a shape that is not a step list is schema_invalid naming the path", () => {
  expect(issue("build")).toBe("steps: expected array");
  expect(issue([])).toBe("steps: Too small: expected array to have >=1 items");
  expect(issue([{ id: "build", type: "worker" }])).toBe(
    "steps.0.role: a worker step needs a role",
  );
  expect(() => readSteps({})).toThrow(StepsInvalid);
});

test("an unknown need, a duplicate id, and a cycle are schema_invalid", () => {
  expect(
    issue([{ id: "a", type: "worker", role: "developer", needs: ["ghost"] }]),
  ).toBe("steps.0.needs.0: unknown step ghost");
  expect(
    issue([
      { id: "a", type: "worker", role: "developer" },
      { id: "a", type: "worker", role: "reviewer" },
    ]),
  ).toBe("steps.1.id: duplicate a");
  expect(
    issue([
      { id: "a", type: "worker", role: "developer", needs: ["b"] },
      { id: "b", type: "worker", role: "reviewer", needs: ["a"] },
    ]),
  ).toBe("steps: cycle a -> b -> a");
});
