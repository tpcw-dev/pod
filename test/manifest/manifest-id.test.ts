import { expect, test } from "vitest";
import type { Revision } from "../../src/core/domain/config.ts";
import type { Run, Story, Task } from "../../src/core/domain/ledger.ts";
import {
  gitStatusReference,
  manifestId,
  revisionReference,
  runReference,
  storyReference,
  taskReference,
} from "../../src/core/manifest/references.ts";

const at = new Date("2026-10-26T00:00:00.000Z");

const story: Story = {
  provider: "tracker",
  external_id: "S-1",
  size: "s",
  stage: "impl",
  run_id: "run-1",
  dependencies: [],
  synced_at: at,
};

const run: Run = {
  run_id: "run-1",
  story_provider: "tracker",
  story_external_id: "S-1",
  host: "local",
  coordinator: "session-1",
  owner_generation: 1,
  snapshot_hash: "hash-1",
  state: "active",
  created_at: at,
};

const task: Task = {
  task_id: "task-1",
  run_id: "run-1",
  step_id: "build",
  lineage_id: "lineage-1",
  role: "developer",
  deps: [],
  spec_revision_id: "spec-1",
  rework_of: null,
  state: "ready",
  created_at: at,
};

function revision(kind: "crew" | "process" | "policy", name: string): Revision {
  return {
    id: `${kind}-${name}`,
    parent: null,
    kind,
    name,
    schema_version: 1,
    rev: 1,
    scope: "global",
    scope_ref: "",
    value: { name },
    actor: "operator",
    reason: "",
    created_at: at,
  };
}

function references() {
  return [
    storyReference(story),
    runReference(run),
    taskReference(task),
    revisionReference(revision("crew", "crew")),
    revisionReference(revision("process", "impl")),
    revisionReference(revision("policy", "policy")),
  ];
}

test("the same sources build the same manifest id twice", () => {
  const first = manifestId(references());
  const second = manifestId(references());
  expect(first).toBe(second);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
});

test("changing one reference changes the manifest id", () => {
  const original = manifestId(references());
  const changed = manifestId([
    storyReference({ ...story, stage: "review" }),
    ...references().slice(1),
  ]);
  expect(changed).not.toBe(original);
});

test("a revision reference cites the revision id, and git status cites the passed time", () => {
  const policy = revision("policy", "policy");
  const cited = revisionReference(policy);
  expect(cited.revision).toBe(policy.id);
  expect(cited.observed_at).toBe(at.toISOString());
  expect(cited.coverage).toBe("full");
  const status = gitStatusReference(" M file\n", at);
  expect(status.source).toBe("git_status");
  expect(status.excerpt).toBe(" M file\n");
  expect(status.observed_at).toBe(at.toISOString());
  const later = gitStatusReference(" M file\n", new Date(at.getTime() + 1000));
  expect(manifestId([status])).not.toBe(manifestId([later]));
});
