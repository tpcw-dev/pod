import { z } from "zod";
import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import type { Revision } from "../domain/config.ts";
import type { Event, Run, Story, Task } from "../domain/ledger.ts";

export const manifestSources = [
  "story",
  "run",
  "task",
  "crew",
  "process",
  "policy",
  "decision",
  "delivery",
  "git_status",
  "revision",
] as const;

export const ManifestReference = z.object({
  source: z.enum(manifestSources),
  revision: z.string(),
  observed_at: z.string(),
  coverage: z.literal("full"),
  excerpt: z.string(),
});
export type ManifestReference = z.infer<typeof ManifestReference>;

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

export function taskSpecReference(revision: Revision): ManifestReference {
  const observedAt = iso(revision.created_at);
  return {
    source: "revision",
    revision: revision.id,
    observed_at: observedAt,
    coverage: "full",
    excerpt: canonicalJson({
      id: revision.id,
      kind: revision.kind,
      name: revision.name,
      rev: revision.rev,
      value: revision.value,
    }),
  };
}

export function deliveryReference(event: Event): ManifestReference {
  const observedAt = iso(event.ts);
  const canonical = canonicalJson({
    dispatch_id: event.dispatch_id,
    event_id: event.id,
    payload: event.payload,
    task_id: event.task_id,
    ts: observedAt,
  });
  return reference("delivery", canonical, observedAt, canonical);
}

export function manifestText(references: readonly ManifestReference[]): string {
  return references
    .map((row) => `- ${row.source}:${row.revision} ${row.excerpt}`)
    .join("\n");
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
