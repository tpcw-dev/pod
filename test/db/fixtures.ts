import { revisionId } from "../../src/core/config/canonical-json.ts";
import type {
  Revision,
  RevisionEnvelope,
} from "../../src/core/domain/config.ts";
import type { Repo } from "../../src/core/ports/db.ts";

export function envelope(
  kind: RevisionEnvelope["kind"],
  name: string,
  value: RevisionEnvelope["value"],
): RevisionEnvelope {
  return {
    kind,
    name,
    schema_version: 1,
    scope: "global",
    scope_ref: "",
    parent: null,
    value,
  };
}

export async function storeRevision(
  db: Repo,
  e: RevisionEnvelope,
): Promise<Revision> {
  const { revision } = await db.insertRevision({
    ...e,
    id: revisionId(e),
    actor: "operator",
    reason: "",
  });
  return revision;
}
