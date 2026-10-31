export interface ScrubTerms {
  hosts: readonly string[];
  users: readonly string[];
  roots: readonly string[];
  denylist: readonly string[];
}

export interface Scrubber {
  scrub(text: string): string;
  hits(text: string): string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function word(term: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`,
    "gi",
  );
}

function distinct(terms: readonly string[]): string[] {
  return [...new Set(terms.filter((term) => term.trim() !== ""))];
}

function byLength(terms: readonly string[]): string[] {
  return [...terms].sort((a, b) => b.length - a.length);
}

const homePath = /\/(?:home|Users)\/[^\s"'\\]+/g;

export function makeScrubber(terms: ScrubTerms): Scrubber {
  const paths = new Map<string, string>();
  const hosts = new Map<string, string>();
  const users = new Map<string, string>();
  const pathFor = (path: string) => {
    let mapped = paths.get(path);
    if (mapped === undefined) {
      mapped = `/w/${paths.size + 1}`;
      paths.set(path, mapped);
    }
    return mapped;
  };
  const label = (
    map: Map<string, string>,
    key: string,
    make: (n: number) => string,
  ) => {
    const lower = key.toLowerCase();
    let mapped = map.get(lower);
    if (mapped === undefined) {
      mapped = make(map.size);
      map.set(lower, mapped);
    }
    return mapped;
  };
  const roots = byLength(distinct(terms.roots));
  const hostTerms = byLength(distinct(terms.hosts));
  const userTerms = byLength(distinct(terms.users));
  const denylist = distinct(terms.denylist.map((term) => term.trim()));
  return {
    scrub(text) {
      let out = text;
      for (const root of roots) out = out.replaceAll(root, () => pathFor(root));
      out = out.replace(homePath, (path) => pathFor(path));
      for (const host of hostTerms)
        out = out.replace(word(host), (hit) =>
          label(hosts, hit, (n) => `host-${String.fromCharCode(97 + n)}`),
        );
      for (const user of userTerms)
        out = out.replace(word(user), (hit) =>
          label(users, hit, (n) => `user-${n + 1}`),
        );
      return out;
    },
    hits(text) {
      return denylist.filter((term) => word(term).test(text));
    },
  };
}

export class FixtureRefused extends Error {
  constructor(
    readonly file: string,
    readonly terms: readonly string[],
  ) {
    super(`fixture ${file} still matches ${terms.length} denylist term(s)`);
  }
}
