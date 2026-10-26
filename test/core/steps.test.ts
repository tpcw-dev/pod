import { expect, test } from "vitest";
import {
  readSteps,
  StepsInvalid,
  topoOrder,
} from "../../src/core/run/steps.ts";

function issue(value: unknown): string {
  try {
    readSteps(value);
  } catch (error) {
    if (error instanceof StepsInvalid) return error.path;
    throw error;
  }
  throw new Error("readSteps accepted the value");
}

test("steps come out in dependency order, ready without deps and pending with them", () => {
  const steps = readSteps({
    steps: [
      { id: "review", role: "reviewer", deps: ["build"], gate: "pr" },
      { id: "build", role: "developer", spec: "Build it." },
      { id: "plan", role: "developer", decision: "plan" },
    ],
  });
  const ordered = topoOrder(steps);
  expect(ordered.map((step) => step.id)).toEqual(["build", "plan", "review"]);
  expect(
    ordered.map((step) => (step.deps.length === 0 ? "ready" : "pending")),
  ).toEqual(["ready", "ready", "pending"]);
  expect(ordered[0]?.spec).toBe("Build it.");
});

test("a shape that is not a step list is schema_invalid naming the path", () => {
  expect(issue({ steps: "build" })).toBe("steps: expected array");
  expect(issue({})).toBe("steps: expected array");
  expect(issue({ steps: [] })).toBe("steps: expected at least one step");
  expect(issue({ steps: [{ id: "build" }] })).toBe(
    "steps.0.role: expected string",
  );
});

test("an unknown dep, a duplicate id, and a cycle are schema_invalid", () => {
  expect(
    issue({ steps: [{ id: "a", role: "developer", deps: ["ghost"] }] }),
  ).toBe("steps.0.deps.0: unknown step ghost");
  expect(
    issue({
      steps: [
        { id: "a", role: "developer" },
        { id: "a", role: "reviewer" },
      ],
    }),
  ).toBe("steps.1.id: duplicate a");
  expect(
    issue({
      steps: [
        { id: "a", role: "developer", deps: ["b"] },
        { id: "b", role: "reviewer", deps: ["a"] },
      ],
    }),
  ).toBe("steps: cycle a -> b -> a");
});
