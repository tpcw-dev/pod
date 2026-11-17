import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import type { Intent, Operation } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export function derivedOpKey(
  intent: Intent | "deploy" | "stop",
  fields: Record<string, string>,
): string {
  return `${intent}:${sha256Hex(canonicalJson({ intent, ...fields }))}`;
}

function attemptKey(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}:${attempt}`;
}

export interface Attempt {
  attempt: number;
  opKey: string;
  operation: Operation | null;
}

/** The newest attempt recorded under `base`, or attempt 1 with no row. */
export async function newestAttempt(
  db: Pick<Repo, "getOperation">,
  base: string,
): Promise<Attempt> {
  let newest: Attempt = { attempt: 1, opKey: base, operation: null };
  for (let attempt = 1; ; attempt += 1) {
    const opKey = attemptKey(base, attempt);
    const operation = await db.getOperation(opKey);
    if (operation === null) return newest;
    newest = { attempt, opKey, operation };
  }
}

export function nextAttempt(base: string, newest: Attempt): Attempt {
  const attempt = newest.attempt + 1;
  return { attempt, opKey: attemptKey(base, attempt), operation: null };
}
