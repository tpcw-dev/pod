import { expect, test } from "vitest";
import {
  renderTaskView,
  type TaskViewInput,
} from "../../src/core/manifest/task-view.ts";

function words(count: number, token: string): string {
  return Array.from({ length: count }, () => token).join(" ");
}

function input(overrides: Partial<TaskViewInput> = {}): TaskViewInput {
  return {
    policies: [],
    reserved: [],
    decisions: [],
    roadmap: [],
    sources: [],
    ...overrides,
  };
}

test("a large untrimmable section stays and the trimmable section is cut", () => {
  const policies = words(1500, "policy");
  const body = words(1500, "source");
  const view = renderTaskView(
    input({
      policies: [policies],
      sources: [
        { title: "Story", body, routing: "pod brief story:S-1" },
      ],
    }),
  );
  expect(view.text).toContain(policies);
  expect(view.text).not.toContain(body);
  expect(view.truncated).toBe(true);
  expect(view.routing).toEqual(["pod brief story:S-1"]);
  expect(view.words).toBeLessThanOrEqual(2000);
});

test("untrimmable text over the budget is kept and is not truncated", () => {
  const policies = words(2001, "policy");
  const view = renderTaskView(input({ policies: [policies] }));
  expect(view.text).toContain(policies);
  expect(view.truncated).toBe(false);
  expect(view.routing).toEqual([]);
  expect(view.words).toBeGreaterThan(2000);
});

test("git status over the budget stays first", () => {
  const gitStatus = words(2001, "git");
  const body = words(50, "source");
  const view = renderTaskView(
    input({
      gitStatus,
      sources: [{ title: "Story", body, routing: "pod brief story:S-1" }],
    }),
  );
  expect(view.text.startsWith(gitStatus)).toBe(true);
  expect(view.text).not.toContain(body);
  expect(view.truncated).toBe(true);
});

test("an expired decision is cut and a current milestone stays", () => {
  const current = words(1800, "now");
  const expired = words(500, "old");
  const view = renderTaskView(
    input({
      roadmap: [{ text: current, current: true, routing: "roadmap" }],
      decisions: [{ text: expired, expired: true, routing: "pod brief story:S-1" }],
    }),
  );
  expect(view.text).toContain(current);
  expect(view.text).not.toContain(expired);
  expect(view.routing).toEqual(["pod brief story:S-1"]);
});
