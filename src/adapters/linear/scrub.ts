import {
  makeScrubber,
  type Replacement,
  type Scrubber,
} from "../../core/domain/scrub.ts";

export {
  parseReplacements,
  ReplacementListInvalid,
  type Replacement,
} from "../../core/domain/scrub.ts";

export interface TrackerScrubTerms {
  hosts: readonly string[];
  users: readonly string[];
  roots: readonly string[];
  workspace: readonly string[];
  denylist: readonly string[];
  replacements?: readonly Replacement[];
}

const identifier =
  /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]{1,9})-(\d+)(?![A-Za-z0-9_])/g;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function word(term: string, flags: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`,
    flags,
  );
}

export function makeTrackerScrubber(terms: TrackerScrubTerms): Scrubber {
  const base = makeScrubber({
    hosts: terms.hosts,
    users: terms.users,
    roots: terms.roots,
    denylist: terms.denylist,
    ...(terms.replacements === undefined
      ? {}
      : { replacements: terms.replacements }),
  });
  const issues = new Map<string, string>();
  const ids = new Map<string, string>();
  const teamKeys = new Set<string>();
  const workspace = terms.workspace.filter((term) => term.trim() !== "");
  return {
    scrub(text) {
      let out = text.replace(identifier, (hit, key: string) => {
        if (key === "TRK") return hit;
        teamKeys.add(key);
        let mapped = issues.get(hit);
        if (mapped === undefined) {
          mapped = `TRK-${issues.size + 1}`;
          issues.set(hit, mapped);
        }
        return mapped;
      });
      for (const key of teamKeys) out = out.replace(word(key, "g"), "trk");
      for (const term of workspace) out = out.replace(word(term, "gi"), "trk");
      out = out.replace(uuid, (hit) => {
        const lower = hit.toLowerCase();
        let mapped = ids.get(lower);
        if (mapped === undefined) {
          mapped = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`;
          ids.set(lower, mapped);
        }
        return mapped;
      });
      return base.scrub(out);
    },
    hits: (text) => base.hits(text),
  };
}
