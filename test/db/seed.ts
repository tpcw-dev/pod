import type { Kind, Revision } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Db } from "../../src/core/ports/db.ts";
import { envelope, storeRevision } from "./fixtures.ts";

const at = new Date("2026-10-26T00:00:00.000Z");

export async function activeRevision(
  db: Db,
  kind: Kind,
  name: string,
  value: Json,
): Promise<Revision> {
  const revision = await storeRevision(db, envelope(kind, name, value));
  const result = await db.activate({
    scope: "global",
    scope_ref: "",
    kind,
    name,
    expected: null,
    revision_id: revision.id,
    bundle_id: null,
    activated_by: "operator",
    activated_at: at,
  });
  if (!result.ok) throw new Error(`${kind}.${name} is already active`);
  return revision;
}

export const crewValue = {
  seats: [
    { id: "dev-1", roles: ["developer"], runtime: "claude", model: "m-1", effort: "low" },
    { id: "rev-1", roles: ["reviewer"], runtime: "codex" },
    { id: "far-1", roles: ["developer"], runtime: "claude", host: "elsewhere" },
    { id: "both-1", roles: ["developer", "reviewer"], runtime: "claude" },
  ],
};

export const processValue = {
  steps: [
    { id: "build", role: "developer", spec: "Build it." },
    { id: "review", role: "reviewer", deps: ["build"], gate: "pr" },
  ],
};

export async function seedConfig(db: Db): Promise<{ process: Revision; crew: Revision; policy: Revision }> {
  const policy = await activeRevision(db, "policy", "default", { gates: [] });
  const crew = await activeRevision(db, "crew", "default", crewValue);
  const process = await activeRevision(db, "process", "impl", processValue);
  return { process, crew, policy };
}
