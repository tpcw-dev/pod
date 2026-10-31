import { deliveryTests } from "../domain/delivery.ts";
import type { EvidenceManifest, TestResult } from "../domain/ledger.ts";
import { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";
import type { OrcaMessage } from "../ports/orca.ts";
import { manifestId, type ManifestReference } from "./references.ts";

export interface ManifestRecordInput {
  run_id: string;
  task_id: string | null;
  decision_id: string | null;
  parent_id: string | null;
  created_at: Date;
  references: readonly ManifestReference[];
  tests?: TestResult[] | null;
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
    tests: input.tests ?? null,
    created_at: input.created_at,
  });
}

export async function recordDeliveryTests(
  repo: Pick<Repo, "setManifestTests">,
  storedId: string | null,
  message: OrcaMessage,
): Promise<string[]> {
  const parsed = deliveryTests(message);
  if (parsed.tests === undefined) return parsed.ignored;
  if (storedId === null)
    return [
      ...parsed.ignored,
      `ignored tests on message ${message.id}: no manifest`,
    ];
  await repo.setManifestTests(storedId, parsed.tests);
  return parsed.ignored;
}
