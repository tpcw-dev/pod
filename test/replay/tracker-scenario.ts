import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { trackerFor } from "../../src/cli/tracker.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import type { OutboxPayload } from "../../src/core/domain/ledger.ts";
import { receiptLog, type ReceiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { runCli } from "../db/helpers.ts";

export const orcaDir = "fixtures/orca/stale-dispatch-id";

export const recording = (process.env["POD_TRACKER_RECORD"] ?? "") !== "";

export function storyId(): string {
  if (!recording) return "TRK-1";
  const id = process.env["POD_TRACKER_STORY"] ?? "";
  if (id === "") throw new Error("recording needs POD_TRACKER_STORY");
  return id;
}

export function applyConfig(): void {
  for (const kind of ["policy", "crew", "process"]) {
    const applied = runCli([
      "config",
      "apply",
      `test/replay/stale-dispatch-id/${kind}.yaml`,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(applied.status, kind).toBe(0);
  }
}

export interface Scenario {
  log: ReceiptLog;
  tracker: TrackerPort & { assertDone?: () => void };
  story: { provider: string; external_id: string };
}

export async function scenario(
  conn: Connection,
  dir: string,
): Promise<Scenario> {
  const log = receiptLog(conn.db, "rec");
  const wired = recording
    ? await trackerFor(log.trackerSink, {
        hostId: "rec",
        urlEnv: "POD_DB_URL",
        capacity: 2,
        trackerKind: "linear",
        trackerTokenEnv: "POD_TRACKER_TOKEN",
        estimateScale: "fibonacci",
        docsKind: "notion",
        docsTokenEnv: "POD_DOCS_TOKEN",
      })
    : null;
  const tracker =
    wired?.port ??
    makeReplayTracker({
      dir: process.env["POD_TRACKER_FIXTURES"] ?? dir,
      sink: log.trackerSink,
      estimateScale: "fibonacci",
    });
  return {
    log,
    tracker,
    story: { provider: "linear", external_id: storyId() },
  };
}

export async function startRun(
  conn: Connection,
  { log, story }: Scenario,
  processName = "stale-dispatch-id",
): Promise<{ orca: ReturnType<typeof makeReplayOrca>; runId: string }> {
  const orca = makeReplayOrca({ dir: orcaDir, sink: log.sink });
  const created = await runCreate(conn.db, orca, null, log, {
    story: story.external_id,
    process: { name: processName, rev: 1 },
    size: "s",
    stage: "impl",
    coordinator: "record",
    host: "rec",
    provider: story.provider,
    command: `pod run create story:${story.external_id}`,
    now: () => new Date(),
  });
  if (!created.ok) throw new Error(created.refusal.message);
  const task = created.result.tasks[0]?.task_id ?? "";
  const started = await dispatch(conn.db, orca, log, {
    task,
    seat: "rec-dev",
    generation: 1,
    opKey: null,
    host: "rec",
    capacity: 2,
    command: (opKey) => `pod dispatch --op-key ${opKey}`,
    now: () => new Date(),
  });
  if (!started.ok) throw new Error(started.refusal.message);
  return { orca, runId: created.result.run_id };
}

export function secondCheckOrca(log: ReceiptLog) {
  const dir = mkdtempSync(join(tmpdir(), "pod-orca-again-"));
  for (const name of [
    "004-check.json",
    "005-check.json",
    "006-worker-list.json",
  ])
    copyFileSync(join(orcaDir, name), join(dir, name));
  return makeReplayOrca({ dir, sink: log.sink });
}

export async function enqueue(
  conn: Connection,
  payload: OutboxPayload,
): Promise<number> {
  await conn.db.insertOperation({
    op_key: "verdict-fixture",
    intent: "verdict",
    owner_generation: 1,
    at: new Date(),
  });
  const row = await conn.db.enqueueOutbox({
    op_key: "verdict-fixture",
    target: "tracker",
    payload,
  });
  return row.id;
}

export function check(
  conn: Connection,
  orca: OrcaPort,
  { tracker, log }: Scenario,
  runId: string,
) {
  return checkPass(conn.db, orca, tracker, log, {
    run: runId,
    generation: 1,
    host: "rec",
    capacity: 2,
    leaseSeconds: launchLeaseSeconds,
    now: () => new Date(),
  });
}

export async function trackerReceipts(
  conn: Connection,
): Promise<{ verb: string; operation: string }[]> {
  return conn.sql<{ verb: string; operation: string }[]>`
    select source->>'verb' as verb, payload->>'operation' as operation
    from ledger.event
    where type = 'receipt' and payload ? 'operation'
    order by id`;
}
