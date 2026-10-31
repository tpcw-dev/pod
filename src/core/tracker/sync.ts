import type { Run } from "../domain/ledger.ts";
import { fence } from "../check/fence.ts";
import { canMove, TaskState } from "../domain/task-state.ts";
import { moveTask } from "../ledger/move-task.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { TrackerPort } from "../ports/tracker.ts";

export async function cancelRun(
  tx: Repo,
  runId: string,
  status: string,
  host: string,
  at: Date,
): Promise<boolean> {
  const run = await tx.lockRun(runId);
  if (run === null) return false;
  if ((await tx.firstEvent(runId, ["cancel"], { runWide: true })) !== null)
    return false;
  const base = {
    ts: at,
    host,
    run_id: runId,
    dispatch_id: null,
    op_key: null,
    source: { kind: "command", verb: "check" },
  };
  await tx.appendEvent({
    ...base,
    type: "cancel",
    task_id: null,
    payload: { reason: "tracker_canceled", status },
  });
  if (run.state === "active" || run.state === "drained") {
    await tx.setRunState(runId, "hold");
    await tx.appendEvent({
      ...base,
      type: "hold",
      task_id: null,
      payload: { reason: "tracker_canceled", from: run.state },
    });
  }
  for (const task of await tx.listTasks(runId)) {
    const from = TaskState.safeParse(task.state);
    if (!from.success || from.data === "hold" || !canMove(from.data, "hold"))
      continue;
    await moveTask(tx, task.task_id, "hold");
    await tx.appendEvent({
      ...base,
      type: "hold",
      task_id: task.task_id,
      payload: { reason: "tracker_canceled", from: task.state },
    });
  }
  return true;
}

export interface SyncInput {
  run: Run;
  generation: number;
  host: string;
  now: () => Date;
}

export interface Synced {
  status: string | null;
  canceled: boolean;
  error: string | null;
}

export async function syncStory(
  db: Db,
  tracker: TrackerPort,
  log: ReceiptLog,
  input: SyncInput,
): Promise<Synced> {
  const { run } = input;
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const read = await tracker.readStory({
    provider: run.story_provider,
    external_id: run.story_external_id,
  });
  const story = read.result;
  if (!read.ok || story === null)
    return {
      status: null,
      canceled: false,
      error: read.ok ? "story_not_found" : (read.error ?? "failed"),
    };
  const canceled = story.statusType === "canceled";
  await db.transaction(async (tx) => {
    await fence(tx, run.run_id, input.generation);
    const at = input.now();
    await tx.syncStory(run.story_provider, run.story_external_id, {
      status: story.status,
      title: story.title,
      kickoff_line: story.kickoffText,
      synced_at: at,
    });
    if (canceled) await cancelRun(tx, run.run_id, story.status, input.host, at);
  });
  return { status: story.status, canceled, error: null };
}
