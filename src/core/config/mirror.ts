import { join } from "node:path";
import { stringify } from "yaml";
import { kinds, scopes, type Revision } from "../domain/config.ts";
import type { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";

export const mirrorRoot = "specs";

export function scopeText(row: { scope: string; scope_ref: string }): string {
  return row.scope_ref === "" ? row.scope : `${row.scope}:${row.scope_ref}`;
}

export async function mirrorSet(repo: Repo): Promise<Revision[]> {
  const revisions: Revision[] = [];
  for (const kind of kinds)
    for (const scope of scopes) {
      if (kind === "task" && scope === "run") continue;
      for (const scopeRef of await repo.activeScopeRefs(kind, scope))
        for (const row of await repo.listActivations(kind, scope, scopeRef)) {
          const revision = await repo.getRevision(row.revision_id);
          if (revision !== null) revisions.push(revision);
        }
    }
  return revisions;
}

function segment(text: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(text) && !/^\.+$/.test(text);
}

export function mirrorPath(revision: Revision): string | null {
  if (!segment(revision.kind) || !segment(revision.name)) return null;
  const file = `${revision.name}.yaml`;
  if (revision.scope === "global") return join(mirrorRoot, revision.kind, file);
  if (!segment(revision.scope_ref)) return null;
  return join(
    mirrorRoot,
    revision.kind,
    revision.scope,
    revision.scope_ref,
    file,
  );
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key] as Json)]),
  );
}

export function mirrorYaml(revision: Revision): string {
  return stringify({
    kind: revision.kind,
    name: revision.name,
    schema_version: revision.schema_version,
    scope: revision.scope,
    scope_ref: revision.scope_ref,
    parent: revision.parent,
    value: sorted(revision.value),
  });
}
