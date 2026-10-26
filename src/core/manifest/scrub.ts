import { canonicalJson } from "../config/canonical-json.ts";
import type { ManifestReference } from "./references.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function exportManifest(
  manifest: { references: readonly ManifestReference[] },
  terms: readonly string[],
): string {
  const ordered = [...terms]
    .filter((term) => term !== "")
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  let exported = canonicalJson(manifest.references);
  for (const term of ordered) {
    exported = exported.replace(
      new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi"),
      "[scrubbed]",
    );
  }
  return exported;
}
