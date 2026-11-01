import type { Json } from "../domain/json.ts";
import {
  reservedClasses,
  type Authorization,
  type Reserved,
  type ReservedClass,
} from "../domain/policy.ts";

export interface ReservedHit {
  class: ReservedClass;
  member: string;
  requires: string | null;
}

export interface ReservedRequest {
  category: string;
  question: string;
  options: readonly string[];
  spec: Json | null;
}

function leaves(value: Json | null): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(leaves);
  return [];
}

const wordEdge = /[\p{L}\p{N}_]/u;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  const lower = term.toLowerCase();
  const before = wordEdge.test(lower.at(0) ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
  const plural = /\p{L}$/u.test(lower) ? "(?:e?s)?" : "";
  const after = wordEdge.test(lower.at(-1) ?? "") ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${before}${escape(lower)}${plural}${after}`, "u");
}

function hits(texts: readonly string[], terms: readonly string[]): boolean {
  const patterns = terms.map(termPattern);
  return texts.some((text) => {
    const lower = text.toLowerCase();
    return patterns.some((pattern) => pattern.test(lower));
  });
}

export function reservedCheck(
  reserved: Reserved,
  request: ReservedRequest,
): ReservedHit[] {
  const texts = [
    request.category,
    [request.question, ...request.options].join("\n"),
    ...leaves(request.spec),
  ];
  for (const kind of reservedClasses) {
    const found = reserved[kind]
      .filter((member) =>
        hits(texts, [
          member.name,
          member.name.replaceAll("_", " "),
          ...member.match,
        ]),
      )
      .map((member) => ({
        class: kind,
        member: member.name,
        requires: member.requires,
      }));
    if (found.length > 0)
      return kind === "needs_existing_authorization"
        ? found
        : found.slice(0, 1);
  }
  return [];
}

export function authorized(
  hit: ReservedHit,
  authorization: Authorization | null,
): boolean {
  if (authorization === null || !authorization.authorizes.includes(hit.member))
    return false;
  return (
    hit.requires !== "infrastructure_story" ||
    authorization.story_kind === "infrastructure"
  );
}

export function firstUnauthorized(
  hits: readonly ReservedHit[],
  authorization: Authorization | null,
): ReservedHit | null {
  return hits.find((hit) => !authorized(hit, authorization)) ?? null;
}
