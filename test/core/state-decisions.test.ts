import { expect, test } from "vitest";
import type { Decision } from "../../src/core/domain/decision.ts";
import { applicableDecisions } from "../../src/core/state/decisions.ts";

const at = new Date("2026-10-31T00:00:00Z");
const daysBefore = (days: number) =>
  new Date(at.getTime() - days * 86_400_000);
const project = { story: "S-1", project: "pod" };

function decision(over: Partial<Decision>): Decision {
  return {
    id: "d",
    scope: { kind: "global" },
    question: "q",
    outcome: "agreed",
    decided_at: daysBefore(1),
    in_force_until: null,
    standing: false,
    ...over,
  };
}

function ids(decisions: readonly Decision[]) {
  return applicableDecisions(decisions, project, at).map((row) => row.id);
}

test("a decision with no in_force_until applies within 30 days of its decision", () => {
  expect(
    ids([
      decision({ id: "fresh", decided_at: daysBefore(29) }),
      decision({ id: "old", decided_at: daysBefore(31) }),
    ]),
  ).toEqual(["fresh"]);
});

test("a decision whose in_force_until has passed does not apply", () => {
  expect(
    ids([
      decision({ id: "expired", in_force_until: daysBefore(1) }),
      decision({ id: "in force", in_force_until: new Date(at.getTime() + 1) }),
      decision({ id: "ends now", in_force_until: at }),
    ]),
  ).toEqual(["in force"]);
});

test("a standing decision older than 30 days still applies", () => {
  expect(
    ids([decision({ id: "standing", decided_at: daysBefore(45), standing: true })]),
  ).toEqual(["standing"]);
});

test("a decision scoped to another project or story does not apply", () => {
  expect(
    ids([
      decision({ id: "global" }),
      decision({ id: "this project", scope: { kind: "project", ref: "pod" } }),
      decision({ id: "other project", scope: { kind: "project", ref: "web" } }),
      decision({ id: "this story", scope: { kind: "story", ref: "S-1" } }),
      decision({ id: "other story", scope: { kind: "story", ref: "S-2" } }),
    ]),
  ).toEqual(["global", "this project", "this story"]);
  expect(
    applicableDecisions(
      [decision({ id: "project", scope: { kind: "project", ref: "pod" } })],
      { story: null, project: null },
      at,
    ),
  ).toEqual([]);
});
