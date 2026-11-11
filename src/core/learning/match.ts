import type { Adoption } from "../domain/learning.ts";

export interface Candidate {
  id: number;
  kind: string;
  expected: string | null;
  evidence_refs: string[];
}

export interface MatchRequest {
  kind: string;
  expected: string | null;
  evidence_refs: string[];
}

const reopenWindowMs = 72 * 60 * 60 * 1000;

export function normalizeExpected(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const normal = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normal === "" ? null : normal;
}

export function sortedRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
}

export function evidenceId(refs: readonly string[]): string {
  return sortedRefs(refs).join(" ");
}

const codePath = /^([A-Za-z0-9._-]+):(.+?)(?::\d+(?:-\d+)?)?$/u;

export function codePaths(refs: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const ref of refs) {
    if (ref.includes("://")) continue;
    const found = codePath.exec(ref);
    const repo = found?.[1];
    const path = found?.[2];
    if (repo === undefined || path === undefined) continue;
    if (path.includes("/") || path.includes(".")) paths.add(`${repo}:${path}`);
  }
  return paths;
}

export function matchLearning(
  candidates: readonly Candidate[],
  request: MatchRequest,
): number[] {
  const paths = codePaths(request.evidence_refs);
  return candidates
    .filter((row) => {
      if (row.kind !== request.kind) return false;
      if (request.expected !== null && row.expected === request.expected)
        return true;
      for (const path of codePaths(row.evidence_refs))
        if (paths.has(path)) return true;
      return false;
    })
    .map((row) => row.id);
}

export function reopenedAdoption(
  row: { adoption: Adoption; adoption_at: Date },
  occurrencesSinceAdoption: number,
  now: Date,
): Adoption {
  if (row.adoption === "rejected")
    return occurrencesSinceAdoption >= 2 ? "new" : "rejected";
  if (row.adoption === "done")
    return now.getTime() - row.adoption_at.getTime() <= reopenWindowMs
      ? "new"
      : "done";
  return row.adoption;
}
