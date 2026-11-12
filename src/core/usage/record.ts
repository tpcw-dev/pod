import { Json } from "../domain/json.ts";
import type { Dispatch } from "../domain/ledger.ts";
import {
  tokenFields,
  type Attribution,
  type Pace,
  type TokenField,
  type UnitRow,
  type UsageInput,
  type UsageLimits,
  type WindowRow,
} from "../domain/usage.ts";
import { dispatchWorktree } from "../dispatch/retry.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db, Repo } from "../ports/db.ts";
import { minuteMs, pace } from "./pace.ts";

export type RecordOutcome = "written" | "replayed" | "nothing_new";

export interface SessionResult {
  runtime: string;
  session_id: string;
  attribution: Attribution | null;
  dispatch_id: string | null;
  run_id: string | null;
  first_at: string | null;
  through: string | null;
  rows: number;
  outcome: RecordOutcome;
}

export interface WindowResult {
  runtime: string;
  window: string;
  observed_at: string;
  pace: Pace | null;
  outcome: Exclude<RecordOutcome, "nothing_new">;
}

export interface RecordResult {
  units: number;
  duplicates: number;
  sessions: SessionResult[];
  windows: WindowResult[];
}

export interface RecordInput {
  usage: UsageInput;
  limits: UsageLimits;
  host: string;
  now: () => Date;
}

function sessionsOf(units: readonly UnitRow[]) {
  const seen = new Set<string>();
  const sessions = new Map<string, UnitRow[]>();
  let duplicates = 0;
  for (const unit of units) {
    const key = JSON.stringify([unit.runtime, unit.key]);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const session = JSON.stringify([unit.runtime, unit.session_id]);
    sessions.set(session, [...(sessions.get(session) ?? []), unit]);
  }
  return { sessions: [...sessions.values()], duplicates };
}

function underPath(cwd: string, worktree: string): boolean {
  const root = worktree.endsWith("/") ? worktree.slice(0, -1) : worktree;
  return cwd === root || cwd.startsWith(`${root}/`);
}

function runByPath(
  cwd: string,
  dispatches: readonly Dispatch[],
): string | null {
  let best: { run_id: string; length: number } | null = null;
  for (const row of dispatches) {
    const worktree = dispatchWorktree(row);
    if (worktree === null || !underPath(cwd, worktree)) continue;
    if (best === null || worktree.length > best.length)
      best = { run_id: row.run_id, length: worktree.length };
  }
  return best?.run_id ?? null;
}

async function attribute(
  tx: Repo,
  units: readonly UnitRow[],
  host: string,
): Promise<{
  attribution: Attribution;
  dispatch_id: string | null;
  run_id: string | null;
}> {
  const [first] = units;
  if (first === undefined) throw new Error("a session has no unit");
  const located = await tx.dispatchByLocator(first.runtime, first.session_id);
  if (located !== null)
    return {
      attribution: "locator",
      dispatch_id: located.dispatch_id,
      run_id: null,
    };
  const cwd = [...units].reverse().find((unit) => unit.cwd !== null)?.cwd;
  const runId =
    cwd == null ? null : runByPath(cwd, await tx.hostStartedDispatches(host));
  return runId === null
    ? { attribution: "unattributed", dispatch_id: null, run_id: null }
    : { attribution: "path", dispatch_id: null, run_id: runId };
}

function recorded(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function sums(units: readonly UnitRow[]) {
  const totals = Object.fromEntries(
    tokenFields.map((field) => [
      field,
      recorded(units.map((unit) => unit[field])),
    ]),
  ) as Record<TokenField, number | null>;
  const partial = units.some((unit) =>
    tokenFields.some((field) => unit[field] === null),
  );
  return {
    totals,
    coverage: partial ? ("partial" as const) : ("measured" as const),
  };
}

function byModel(units: readonly UnitRow[]): Map<string | null, UnitRow[]> {
  const groups = new Map<string | null, UnitRow[]>();
  for (const unit of units)
    groups.set(unit.model, [...(groups.get(unit.model) ?? []), unit]);
  return groups;
}

async function recordSession(
  tx: Repo,
  all: readonly UnitRow[],
  input: RecordInput,
): Promise<SessionResult> {
  const [first] = all;
  if (first === undefined) throw new Error("a session has no unit");
  const { runtime, session_id } = first;
  const watermark = await tx.usageWatermark(runtime, session_id);
  const units = all
    .filter((unit) => watermark === null || unit.at > watermark)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const head = units[0];
  const tail = units[units.length - 1];
  const empty = {
    runtime,
    session_id,
    attribution: null,
    dispatch_id: null,
    run_id: null,
    rows: 0,
  };
  if (head === undefined || tail === undefined)
    return { ...empty, first_at: null, through: null, outcome: "nothing_new" };
  const span = {
    first_at: head.at.toISOString(),
    through: tail.at.toISOString(),
  };
  const now = input.now();
  const opKey = derivedOpKey("usage", {
    runtime,
    session_id,
    through: span.through,
  });
  const operation = await tx.insertOperation({
    op_key: opKey,
    intent: "usage",
    owner_generation: 0,
    at: now,
  });
  if (!operation.created) return { ...empty, ...span, outcome: "replayed" };
  const owner = await attribute(tx, units, input.host);
  const ids: number[] = [];
  for (const [model, group] of byModel(units)) {
    const { totals, coverage } = sums(group);
    const row = await tx.insertUsageRecord({
      runtime,
      session_id,
      model,
      ...totals,
      first_at: head.at,
      through: tail.at,
      ...owner,
      coverage,
      op_key: opKey,
      created_at: now,
    });
    ids.push(row.id);
  }
  await tx.moveOperation(opKey, "done", Json.parse({ rows: ids }), now);
  return {
    runtime,
    session_id,
    ...owner,
    ...span,
    rows: ids.length,
    outcome: "written",
  };
}

async function recordWindow(
  tx: Repo,
  window: WindowRow,
  input: RecordInput,
): Promise<WindowResult> {
  const observedAt = window.observed_at.toISOString();
  const used = window.used_percent;
  const windowPace =
    used === null
      ? null
      : pace(
          { ...window, used_percent: used },
          window.observed_at,
          input.limits.floor_percent,
        );
  const result = {
    runtime: window.runtime,
    window: window.window,
    observed_at: observedAt,
    pace: windowPace,
  };
  const now = input.now();
  const opKey = derivedOpKey("usage", {
    runtime: window.runtime,
    window: window.window,
    observed_at: observedAt,
  });
  const operation = await tx.insertOperation({
    op_key: opKey,
    intent: "usage",
    owner_generation: 0,
    at: now,
  });
  if (!operation.created) return { ...result, outcome: "replayed" };
  const row = await tx.insertUsageObservation({
    provider: window.runtime,
    seat: null,
    window_start: new Date(
      window.resets_at.getTime() - window.window_minutes * minuteMs,
    ),
    window_end: window.resets_at,
    value: used === null ? null : String(used),
    coverage: used === null ? "partial" : "measured",
    observed_at: window.observed_at,
    source: Json.parse({
      kind: "usage record",
      window: window.window,
      pace: windowPace,
    }),
  });
  await tx.moveOperation(opKey, "done", Json.parse({ id: row.id }), now);
  return { ...result, outcome: "written" };
}

export async function recordUsage(
  db: Db,
  input: RecordInput,
): Promise<RecordResult> {
  const { sessions, duplicates } = sessionsOf(input.usage.units);
  const result: RecordResult = {
    units: input.usage.units.length,
    duplicates,
    sessions: [],
    windows: [],
  };
  for (const units of sessions)
    result.sessions.push(
      await db.transaction((tx) => recordSession(tx, units, input)),
    );
  for (const window of input.usage.windows)
    result.windows.push(
      await db.transaction((tx) => recordWindow(tx, window, input)),
    );
  return result;
}
