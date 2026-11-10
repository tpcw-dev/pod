import { expect, test } from "vitest";
import { validatePolicy } from "../../src/core/config/policy.ts";
import { validateProcess } from "../../src/core/process/validate.ts";
import { crewValue, processValue } from "../db/seed.ts";

const policy = { gates: ["pr"] };

const withMethod = (method: unknown) => ({
  ...processValue,
  steps: processValue.steps.map((step) =>
    step.id === "review" ? { ...step, method } : step,
  ),
});

test("a process step with a method validates and keeps it", () => {
  const checked = validateProcess(
    withMethod("Review against the acceptance list."),
    crewValue,
    policy,
  );
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.value.steps[1]?.method).toBe(
    "Review against the acceptance list.",
  );
});

test.each([
  ["two lines", "Read the diff.\nThen run the tests."],
  ["a carriage return", "Read the diff.\rThen run the tests."],
  ["201 characters", "x".repeat(201)],
  ["an empty string", ""],
])("a method with %s is schema_invalid at steps.<i>.method", (_, method) => {
  expect(validateProcess(withMethod(method), crewValue, policy)).toMatchObject({
    ok: false,
    refusal: {
      code: "schema_invalid",
      message: expect.stringMatching(/^steps\.1\.method: /),
    },
  });
});

test("a 200-character method validates", () => {
  expect(
    validateProcess(withMethod("x".repeat(200)), crewValue, policy).ok,
  ).toBe(true);
});

test("a profile method map validates without checking step ids", () => {
  expect(
    validatePolicy(
      {
        gates: ["pr"],
        profiles: { p: { method: { review: "Read twice.", absent: "Any." } } },
      },
      null,
    ),
  ).toBeNull();
});
