import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readLearningFile } from "../../src/cli/learning-verbs.ts";
import { PodError } from "../../src/cli/errors.ts";
import {
  learningIdentity,
  learningOpKey,
} from "../../src/core/learning/add.ts";
import { acceptLearningFile } from "../../src/core/domain/learning.ts";

const file = {
  source_story: "S-1",
  evidence_refs: ["pr:1"],
  text: "keep the seam",
};

test("adoption defaults to new", () => {
  const parsed = acceptLearningFile(file);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.file.adoption).toBe("new");
});

test("an empty evidence_refs array is refused", () => {
  const parsed = acceptLearningFile({ ...file, evidence_refs: [] });
  expect(parsed.ok).toBe(false);
});

test("an empty source_story, text, or evidence item is refused", () => {
  for (const value of [
    { ...file, source_story: "" },
    { ...file, text: "" },
    { ...file, evidence_refs: [""] },
  ]) {
    expect(acceptLearningFile(value).ok).toBe(false);
  }
});

test("an area or project key names the flag", () => {
  const area = acceptLearningFile({ ...file, area: "impl" });
  const project = acceptLearningFile({ ...file, project: "alpha" });
  expect(area.ok).toBe(false);
  expect(project.ok).toBe(false);
  if (!area.ok) expect(area.issues.join(" ")).toContain("--area");
  if (!project.ok) expect(project.issues.join(" ")).toContain("--project");
});

test("the op key is the hash of the canonical identity", () => {
  expect(
    learningOpKey(
      learningIdentity({
        source_story: "S-1",
        text: "keep the seam",
        area: "impl",
        project_id: "alpha",
        evidence_refs: ["pr:2", "pr:1"],
        adoption: "new",
        kind: "lead",
        expected: "Keep the seam.",
        reporter: "lead",
      }),
    ),
  ).toBe(
    "learning:b291153d09a4dca34be8de25ffd9893cbcfdda2f9a29daa1fcc4c7deb534cd91",
  );
});

test("the file carries an optional expected", () => {
  const parsed = acceptLearningFile({ ...file, expected: "keep it" });
  expect(parsed.ok && parsed.file.expected).toBe("keep it");
});

test("readLearningFile reports a missing path, bad YAML, and a non-object root", () => {
  const missing = join(tmpdir(), "pod-learning-missing.yaml");
  expect(() => readLearningFile(missing)).toThrow(PodError);
  try {
    readLearningFile(missing);
  } catch (error) {
    expect(error).toMatchObject({ code: "usage" });
  }

  const dir = mkdtempSync(join(tmpdir(), "pod-learning-"));
  const broken = join(dir, "broken.yaml");
  writeFileSync(broken, "[\n");
  expect(() => readLearningFile(broken)).toThrow(PodError);
  try {
    readLearningFile(broken);
  } catch (error) {
    expect(error).toMatchObject({ code: "schema_invalid" });
  }

  const list = join(dir, "list.yaml");
  writeFileSync(list, "- pr:1\n");
  try {
    readLearningFile(list);
    expect.fail("a list is not a learning file");
  } catch (error) {
    expect(error).toMatchObject({
      code: "schema_invalid",
      nextSteps: ["(root): expected an object"],
    });
  }
});
