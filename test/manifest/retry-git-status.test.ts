import { expect, test } from "vitest";
import { renderTaskView } from "../../src/core/manifest/task-view.ts";

test("a retry task view renders git status before every other section", () => {
  const view = renderTaskView({
    gitStatus: " M src/cli/brief.ts",
    policies: ["keep"],
    reserved: [],
    decisions: [],
    roadmap: [],
    sources: [{ title: "Story", body: "body", routing: "pod brief story:S-1" }],
  });
  const gitAt = view.text.indexOf(" M src/cli/brief.ts");
  const policiesAt = view.text.indexOf("Policies");
  const storyAt = view.text.indexOf("Story");
  expect(gitAt).toBe(0);
  expect(policiesAt).toBeGreaterThan(gitAt);
  expect(storyAt).toBeGreaterThan(policiesAt);
  expect(view.truncated).toBe(false);
});
