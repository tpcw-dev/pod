const policy = "the active global policy Revision";

const moves: readonly {
  path: readonly string[];
  to: (hostId: string) => string;
}[] = [
  {
    path: ["capacity"],
    to: (hostId) => `slots.default of the active host Revision host.${hostId}`,
  },
  { path: ["tracker", "kind"], to: () => `tracker.kind of ${policy}` },
  {
    path: ["tracker", "estimate_scale"],
    to: () => `tracker.estimate_scale of ${policy}`,
  },
  { path: ["docs", "kind"], to: () => `docs.kind of ${policy}` },
];

function carries(raw: unknown, path: readonly string[]): boolean {
  let at = raw;
  for (const key of path) {
    if (typeof at !== "object" || at === null || !(key in at)) return false;
    at = (at as Record<string, unknown>)[key];
  }
  return true;
}

export function movedFields(raw: unknown, hostId: string): string[] {
  return moves
    .filter((move) => carries(raw, move.path))
    .map((move) => `${move.path.join(".")}: moved to ${move.to(hostId)}`);
}
