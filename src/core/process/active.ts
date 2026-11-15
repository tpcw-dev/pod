import type { Revision } from "../domain/config.ts";
import type { Repo } from "../ports/db.ts";
import { Selector } from "./schema.ts";
import type { ActiveProcess } from "./select.ts";

export function activeOf(revision: Revision): ActiveProcess | null {
  const value = revision.value;
  const selector = Selector.safeParse(
    value !== null && typeof value === "object" && "selector" in value
      ? value.selector
      : undefined,
  );
  return selector.success
    ? {
        revisionId: revision.id,
        name: revision.name,
        rev: revision.rev,
        selector: selector.data,
      }
    : null;
}

export async function activeProcesses(db: Repo): Promise<ActiveProcess[]> {
  const rows = await db.listActivations("process", "global", "");
  const active: ActiveProcess[] = [];
  for (const row of rows) {
    const revision = await db.getRevision(row.revision_id);
    const process = revision === null ? null : activeOf(revision);
    if (process !== null) active.push(process);
  }
  return active;
}
