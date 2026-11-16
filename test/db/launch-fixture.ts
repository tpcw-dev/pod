import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { hostDay } from "../../src/core/plan/clock.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { started } from "./run-fixture.ts";
import { activeRevision, crewValue, hostValue, processValue } from "./seed.ts";

export const timezone = "America/New_York";
export const morning = new Date("2026-11-16T15:00:00.000Z");
export const lateEvening = new Date("2026-11-17T03:30:00.000Z");
export const attention = { pause_at: "22:00", max_unattended_hours: 12 };
export const worktree = {
  id: "repo-1::/w/s-1",
  path: "/w/s-1",
  branch: "refs/heads/s-1",
};
export const projectValue = {
  repo: "acme/widgets",
  category: "Meta",
  staging: false,
  tracker: { project_name: "Widgets", project_id: "id-widgets" },
};

export function notFound(verb: string, argv: string[]): TempEntry {
  return {
    verb,
    argv,
    exitCode: 1,
    stdout: JSON.stringify({
      ok: false,
      error: { code: "selector_not_found", message: "selector_not_found" },
    }),
  };
}

export const createWorktree: TempEntry[] = [
  notFound("worktree-show", ["--worktree", "name:s-1"]),
  ok("worktree-create", { worktree }, ["--project", "github:acme/widgets"]),
];

export const createRunEntries: TempEntry[] = [
  ok("run-create", { run: { id: "run_1" } }),
  ok("task-create", { task: { id: "task_b", status: "ready" } }),
  ok("task-create", { task: { id: "task_r", status: "pending" } }),
];

export const startLead: TempEntry = ok("worker-start", started("ctx_1"), [
  "--task",
  "task_b",
  "--worktree",
  `id:${worktree.id}`,
]);

export const fullLaunch = [...createWorktree, ...createRunEntries, startLead];

export interface Seed {
  slots?: number;
  reserved?: Record<string, number>;
  policy?: Record<string, Json>;
  crew?: Json;
  process?: Json;
  actor?: string;
  now?: Date;
}

export async function seedLaunch(
  conn: Connection,
  over: Seed = {},
): Promise<void> {
  await activeRevision(conn.db, "policy", "default", {
    gates: ["pr"],
    ...over.policy,
  });
  await activeRevision(conn.db, "crew", "default", over.crew ?? crewValue);
  await activeRevision(
    conn.db,
    "process",
    "impl",
    over.process ?? processValue,
  );
  await activeRevision(conn.db, "project", "widgets", projectValue);
  const host = await storeRevision(conn.db, {
    ...envelope("host", "local", {
      ...(hostValue(over.slots ?? 2) as Record<string, Json>),
      slots: { default: over.slots ?? 2, max: 4 },
      reserved: over.reserved ?? {},
      projects: ["widgets", "gadgets"],
    }),
    scope: "host",
    scope_ref: "local",
  });
  const activated = await conn.db.activate({
    scope: "host",
    scope_ref: "local",
    kind: "host",
    name: "local",
    expected: null,
    revision_id: host.id,
    bundle_id: null,
    activated_by: "operator",
    activated_at: morning,
  });
  if (!activated.ok) throw new Error("host not activated");
  await publishPlan(conn, over.now ?? morning, over.actor ?? "person:human");
}

export async function publishPlan(
  conn: Connection,
  at: Date,
  actor: string,
  keys: readonly string[] = ["S-1"],
): Promise<void> {
  const day = hostDay(at, timezone);
  await conn.db.appendEvent({
    type: "plan",
    ts: at,
    host: "local",
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: `plan:${day}:${actor}`,
    payload: {
      kind: "published",
      host: "local",
      day,
      actor,
      ranked: keys.map((key) => ({
        key,
        project: "widgets",
        title: `Story ${key}`,
        points: 2,
        place: "current",
        priority: null,
        driver: null,
        seats: ["claude"],
        reasons: [],
      })),
      held: [],
      inputs: {
        host_revision: "host.local@1",
        project_revisions: [],
        tracker: null,
        usage_observation_ids: [],
        overrides: [],
      },
    },
    source: { kind: "command", verb: "plan" },
  });
}
