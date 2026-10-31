import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import {
  renderTemplate,
  validateDecisionTemplates,
} from "../../src/core/decide/templates.ts";

const value = {
  decider: "Decide {{question}} for {{decision_id}}",
  auditor: "Audit {{question}} over {{options}}",
  round_open: "Round {{round}} cites {{manifest_id}}:\n{{manifest}}",
  round_next: "Round {{round}}: {{audit}} / {{points_of_disagreement}}",
};

test("each placeholder renders from its field", () => {
  expect(
    renderTemplate(value.round_open, {
      round: "1",
      manifest_id: "m1",
      manifest: "- story S-1",
    }),
  ).toBe("Round 1 cites m1:\n- story S-1");
  expect(
    renderTemplate(value.round_next, {
      round: "2",
      audit: "no rollback",
      points_of_disagreement: "rollback",
    }),
  ).toBe("Round 2: no rollback / rollback");
});

test("a placeholder with no value renders empty, and other braces stay", () => {
  expect(renderTemplate("a {{question}} {b}", {})).toBe("a  {b}");
});

test("the default templates validate", () => {
  const file = parse(readFileSync("specs/decision/default.yaml", "utf8")) as {
    kind: string;
    value: unknown;
  };
  expect(file.kind).toBe("decision");
  expect(validateDecisionTemplates(file.value)).toBeNull();
});

test("a valid value has no problem", () => {
  expect(validateDecisionTemplates(value)).toBeNull();
});

test("a missing field is named", () => {
  const rest: Partial<typeof value> = { ...value };
  delete rest.round_next;
  expect(validateDecisionTemplates(rest)).toEqual({
    path: "value.round_next",
    message: "value.round_next must be a non-empty string",
  });
});

test("an unknown placeholder is named with its field", () => {
  expect(
    validateDecisionTemplates({ ...value, auditor: "Audit {{secret}}" }),
  ).toEqual({
    path: "value.auditor",
    message: "value.auditor uses unknown placeholder {{secret}}",
  });
});

test("an extra field is refused", () => {
  expect(validateDecisionTemplates({ ...value, extra: "x" })).toEqual({
    path: "value.extra",
    message: "value.extra is not a decision template field",
  });
});
