import type { Kind, Revision, Scope } from "../domain/config.ts";
import { refuse } from "../domain/outcome.ts";
import type { Repo } from "../ports/db.ts";

export async function singleActive(
  db: Repo,
  kind: Kind,
  scope: Scope,
  scopeRef: string,
): Promise<Revision | null> {
  let rows = await db.listActivations(kind, scope, scopeRef);
  if (scope !== "global" && rows.length === 0)
    rows = await db.listActivations(kind, "global", "");
  const [only] = rows;
  return rows.length === 1 && only !== undefined
    ? db.getRevision(only.revision_id)
    : null;
}

export function noSingleActive(kind: Kind, scope: Scope, scopeRef: string) {
  const flag = scopeRef === "" ? scope : `${scope}:${scopeRef}`;
  return refuse("selector_none", `no single active ${scope} ${kind} Revision`, [
    `pod config apply ${kind}.yaml --activate --scope ${flag} --expected-revision none`,
  ]);
}
