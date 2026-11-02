import type { EvidenceManifest, Run } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";
import { recordManifest } from "./record.ts";
import {
  revisionReference,
  runReference,
  storyReference,
  taskReference,
} from "./references.ts";

export async function recordRunManifest(
  tx: Repo,
  run: Run,
  at: Date,
): Promise<EvidenceManifest> {
  const story = await tx.getStory(run.story_provider, run.story_external_id);
  const snapshot = await tx.getSnapshot(run.run_id);
  if (story === null || snapshot === null)
    throw new Error(`Run ${run.run_id} lost its Story or Snapshot`);
  const revisions = [];
  for (const id of [
    snapshot.crew_revision_id,
    snapshot.process_revision_id,
    snapshot.policy_revision_id,
  ]) {
    const revision = await tx.getRevision(id);
    if (revision === null)
      throw new Error(`Run ${run.run_id} lost a pinned Revision`);
    revisions.push(revisionReference(revision));
  }
  const { manifest } = await recordManifest(tx, {
    run_id: run.run_id,
    task_id: null,
    decision_id: null,
    parent_id: null,
    created_at: at,
    references: [
      storyReference(story),
      runReference(run),
      ...(await tx.listTasks(run.run_id)).map(taskReference),
      ...revisions,
    ],
  });
  return manifest;
}
