import type { Repo } from "../../src/core/ports/db.ts";

export const operator = "human";

const at = new Date("2026-11-09T00:00:00Z");

export async function seatRun(
  db: Repo,
  runId: string,
  options: { host?: string; coordinator?: string } = {},
): Promise<void> {
  await db.upsertStory({
    provider: "linear",
    external_id: `story-${runId}`,
    size: "s",
    stage: "impl",
    run_id: null,
    dependencies: [],
    synced_at: at,
    status: null,
    title: null,
    kickoff_line: null,
  });
  await db.insertRun({
    run_id: runId,
    story_provider: "linear",
    story_external_id: `story-${runId}`,
    host: options.host ?? "local",
    coordinator: options.coordinator ?? `coordinator-${runId}`,
    owner_generation: 1,
    snapshot_hash: "hash",
    state: "active",
    created_at: at,
    coordinator_dispatch_id: null,
  });
}

export async function openLaunch(db: Repo, opKey: string): Promise<void> {
  await db.insertOperation({
    op_key: opKey,
    intent: "dispatch",
    owner_generation: 1,
    at,
  });
}

export async function seatDispatch(
  db: Repo,
  input: {
    runId: string;
    dispatchId: string;
    seat: string;
    terminal: string | null;
    settled?: boolean;
  },
): Promise<void> {
  const opKey = `launch:${input.dispatchId}`;
  await openLaunch(db, opKey);
  await db.moveOperation(opKey, "done", null, at);
  await db.insertDispatch({
    dispatch_id: input.dispatchId,
    task_id: null,
    decision_id: null,
    run_id: input.runId,
    seat: input.seat,
    role: "decider",
    requested_launch: {},
    effective_launch: null,
    model_attribution: "unknown",
    retry_of: null,
    op_key: opKey,
    settlement: input.settled === true ? "done" : "open",
    terminal_handle: input.terminal,
    created_at: at,
    settled_at: input.settled === true ? at : null,
    activity: input.settled === true ? "settled" : "running",
    manifest_id: null,
    prompt_bytes: null,
  });
}
