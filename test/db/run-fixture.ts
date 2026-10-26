import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  dispatch,
  type DispatchInput,
} from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { fixtures, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { clearDb } from "./helpers.ts";
import { seedConfig } from "./seed.ts";

export const worktreeId = "repo-1::/w/one";

export const devArgv = [
  "--task",
  "task_b",
  "--run",
  "run_1",
  "--agent",
  "claude",
  "--model",
  "m-1",
  "--effort",
  "low",
];

export function started(dispatchId: string, taskId = "task_b"): unknown {
  return {
    dispatchId,
    state: "ready",
    taskId,
    terminalHandle: `term_${dispatchId}`,
    launch: {
      requested: { agent: "claude", model: "m-1", effort: "low" },
      effective: { agent: "claude", model: "m-1", effort: "low" },
    },
    effects: [{ kind: "worktree", action: "reused", id: worktreeId }],
  };
}

export function replay(conn: Connection, entries: readonly TempEntry[]) {
  const log = receiptLog(conn.db, "local");
  return {
    orca: makeReplayOrca({ dir: fixtures(entries), sink: log.sink }),
    log,
  };
}

export async function freshRun(conn: Connection): Promise<void> {
  await clearDb(conn);
  await seedConfig(conn.db);
  const { orca, log } = replay(conn, [
    ok("run-create", { run: { id: "run_1" } }),
    ok("task-create", { task: { id: "task_b", status: "ready" } }),
    ok("task-create", { task: { id: "task_r", status: "pending" } }),
  ]);
  const created = await runCreate(conn.db, orca, log, {
    story: "S-1",
    process: { name: "impl", rev: 1 },
    size: "s",
    stage: "impl",
    coordinator: "session-1",
    host: "local",
    provider: "linear",
    command: "pod run create story:S-1",
    now: () => new Date(),
  });
  if (!created.ok) throw new Error(created.refusal.message);
}

export function dispatchInput(
  over: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    task: "task_b",
    seat: "dev-1",
    generation: 1,
    opKey: null,
    host: "local",
    capacity: 2,
    command: (opKey) => `pod dispatch --op-key ${opKey}`,
    now: () => new Date(),
    ...over,
  };
}

export async function dispatched(
  conn: Connection,
  dispatchId: string,
  over: Partial<DispatchInput> = {},
): Promise<string> {
  const { orca, log } = replay(conn, [
    ok("worker-start", started(dispatchId, over.task ?? "task_b")),
  ]);
  const outcome = await dispatch(conn.db, orca, log, dispatchInput(over));
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.opKey;
}

export function message(
  id: string,
  type: string,
  payload: Record<string, unknown> | string,
): unknown {
  return {
    id,
    type,
    subject: type,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

export function batch(
  deliveryId: string | null,
  messages: unknown[],
  acknowledged: string | null = null,
): unknown {
  return {
    runId: "run_1",
    deliveryId,
    messages,
    count: messages.length,
    acknowledged,
  };
}

export const empty = (acknowledged: string | null = null) =>
  batch(null, [], acknowledged);

export function workers(
  rows: {
    dispatchId: string;
    taskId?: string;
    workerState: string;
    worktreeId?: string;
  }[],
  nextCursor: string | null = null,
): unknown {
  return {
    workers: rows.map((row) => ({
      dispatchId: row.dispatchId,
      taskId: row.taskId ?? "task_b",
      workerState: row.workerState,
      terminalState: "active",
      resource: { worktreeId: row.worktreeId ?? worktreeId },
    })),
    page: {
      limit: 100,
      total: rows.length,
      hasMore: nextCursor !== null,
      nextCursor,
    },
  };
}

export async function events(conn: Connection, type: string) {
  return conn.sql<
    {
      task_id: string | null;
      dispatch_id: string | null;
      payload: Record<string, unknown>;
    }[]
  >`select task_id, dispatch_id, payload from ledger.event where type = ${type} order by id`;
}

export async function taskState(conn: Connection, taskId: string) {
  return (await conn.db.getTask(taskId))?.state;
}
