import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import type { Revision } from "../domain/config.ts";
import type { Run, Story, Task } from "../domain/ledger.ts";

export const manifestSources = [
  "story",
  "run",
  "task",
  "crew",
  "process",
  "policy",
  "git_status",
] as const;

export interface ManifestReference {
  source: (typeof manifestSources)[number];
  revision: string;
  observed_at: string;
  coverage: "full";
  excerpt: string;
}

function iso(date: Date): string {
  return date.toISOString();
}

function reference(
  source: ManifestReference["source"],
  canonical: string,
  observedAt: string,
  excerpt: string,
): ManifestReference {
  return {
    source,
    revision: sha256Hex(canonical),
    observed_at: observedAt,
    coverage: "full",
    excerpt,
  };
}

export function storyReference(story: Story): ManifestReference {
  const observedAt = iso(story.synced_at);
  const canonical = canonicalJson({
    dependencies: story.dependencies,
    external_id: story.external_id,
    provider: story.provider,
    run_id: story.run_id,
    size: story.size,
    stage: story.stage,
    synced_at: observedAt,
  });
  return reference("story", canonical, observedAt, canonical);
}

export function runReference(run: Run): ManifestReference {
  const observedAt = iso(run.created_at);
  const canonical = canonicalJson({
    coordinator: run.coordinator,
    created_at: observedAt,
    host: run.host,
    owner_generation: run.owner_generation,
    run_id: run.run_id,
    snapshot_hash: run.snapshot_hash,
    state: run.state,
    story_external_id: run.story_external_id,
    story_provider: run.story_provider,
  });
  return reference("run", canonical, observedAt, canonical);
}

export function taskReference(task: Task): ManifestReference {
  const observedAt = iso(task.created_at);
  const canonical = canonicalJson({
    created_at: observedAt,
    deps: task.deps,
    lineage_id: task.lineage_id,
    role: task.role,
    run_id: task.run_id,
    spec_revision_id: task.spec_revision_id,
    state: task.state,
    step_id: task.step_id,
    task_id: task.task_id,
  });
  return reference("task", canonical, observedAt, canonical);
}

export function revisionReference(revision: Revision): ManifestReference {
  if (revision.kind === "task")
    throw new TypeError("a task spec is not an S4 revision reference");
  const observedAt = iso(revision.created_at);
  const canonical = canonicalJson({
    id: revision.id,
    kind: revision.kind,
    name: revision.name,
    rev: revision.rev,
  });
  return {
    source: revision.kind,
    revision: revision.id,
    observed_at: observedAt,
    coverage: "full",
    excerpt: canonical,
  };
}

export function gitStatusReference(
  text: string,
  observedAt: Date,
): ManifestReference {
  const canonical = canonicalJson({ text });
  return reference("git_status", canonical, iso(observedAt), text);
}

export function manifestId(references: readonly ManifestReference[]): string {
  return sha256Hex(canonicalJson(references));
}
