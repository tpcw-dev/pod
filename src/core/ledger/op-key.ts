import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import type { Intent } from "../domain/ledger.ts";

export function derivedOpKey(
  intent: Intent,
  fields: Record<string, string>,
): string {
  return `${intent}:${sha256Hex(canonicalJson({ intent, ...fields }))}`;
}
