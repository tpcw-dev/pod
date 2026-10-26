import type { EvidenceManifest } from "../domain/ledger.ts";
import { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";
import { manifestId, type ManifestReference } from "./references.ts";

export interface ManifestRecordInput {
  run_id: string;
  task_id: string | null;
  decision_id: string | null;
  parent_id: string | null;
  created_at: Date;
  references: readonly ManifestReference[];
}

export async function recordManifest(
  repo: Pick<Repo, "insertManifest">,
  input: ManifestRecordInput,
): Promise<{ manifest: EvidenceManifest; created: boolean }> {
  return repo.insertManifest({
    id: manifestId(input.references),
    run_id: input.run_id,
    task_id: input.task_id,
    decision_id: input.decision_id,
    parent_id: input.parent_id,
    references: Json.parse(input.references),
    created_at: input.created_at,
  });
}
