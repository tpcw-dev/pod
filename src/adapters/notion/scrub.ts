import { makeScrubber, type Scrubber } from "../../core/domain/scrub.ts";

export interface DocsScrubTerms {
  hosts: readonly string[];
  users: readonly string[];
  roots: readonly string[];
  workspace: readonly string[];
  denylist: readonly string[];
}

const id =
  /(?<![0-9a-f])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f])/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function word(term: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`,
    "gi",
  );
}

export function makeDocsScrubber(terms: DocsScrubTerms): Scrubber {
  const base = makeScrubber({
    hosts: terms.hosts,
    users: terms.users,
    roots: terms.roots,
    denylist: terms.denylist,
  });
  const ids = new Map<string, string>();
  const workspace = terms.workspace.filter((term) => term.trim() !== "");
  return {
    scrub(text) {
      let out = text.replace(id, (hit) => {
        const key = hit.toLowerCase().replaceAll("-", "");
        let mapped = ids.get(key);
        if (mapped === undefined) {
          mapped = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`;
          ids.set(key, mapped);
        }
        return mapped;
      });
      for (const term of workspace) out = out.replace(word(term), "docs");
      return base.scrub(out);
    },
    hits: (text) => base.hits(text),
  };
}

const userFields = new Set(["created_by", "last_edited_by"]);

function trimmed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trimmed);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]: [string, unknown]) => {
      if (userFields.has(key) && item !== null && typeof item === "object") {
        const { object, id: userId } = item as Record<string, unknown>;
        return [key, { object, id: userId }];
      }
      return [key, trimmed(item)];
    }),
  );
}

export function trimUsers(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return body;
  }
  return JSON.stringify(trimmed(parsed));
}
