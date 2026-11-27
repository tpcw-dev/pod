import { z } from "zod";
import type { Run, Task } from "../domain/ledger.ts";
import {
  Envelope,
  failure,
  unknownReply,
  type LaunchOutcome,
} from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt } from "../ports/orca.ts";
import { readProcess } from "./project.ts";

export interface SettleContext {
  db: Db;
  orca: OrcaPort;
  log: ReceiptLog;
  now: () => Date;
}

const runtimeStatus: Partial<Record<Task["state"], string>> = {
  done: "completed",
  failed: "completed",
};

function settleOpKey(run_id: string, task_id: string, status: string) {
  return derivedOpKey("task_update", { run_id, task_id, status });
}

/**
 * A gate Task whose runtime task was once settled failed keeps that settle,
 * so its dependents stay held in the runtime.
 */
export async function settledFailedBefore(
  db: Repo,
  task: Pick<Task, "run_id" | "task_id">,
): Promise<boolean> {
  return (
    (await db.getOperation(
      settleOpKey(task.run_id, task.task_id, "failed"),
    )) !== null
  );
}

const OpenRequest = z.looseObject({ requestId: z.string().nullish() });

export function settleOutcome(receipt: Receipt<unknown>): LaunchOutcome {
  const unknown = unknownReply(receipt);
  if (unknown !== null) return unknown;
  return receipt.exitCode === 0 && Envelope.parse(receipt.raw).ok !== false
    ? { kind: "ok" }
    : { kind: "failed" };
}

/**
 * A human_wait or external_action step has no worker to settle its runtime
 * task, so Pod sends the update once the ledger has settled the Task.
 */
export async function settleRuntime(
  ctx: SettleContext,
  run: Run,
  taskId: string,
): Promise<string[]> {
  const { db, orca, log } = ctx;
  const task = await db.getTask(taskId);
  const status = task === null ? undefined : runtimeStatus[task.state];
  if (task === null || status === undefined) return [];
  const { step } = await readProcess(db, task, task.state);
  if (step.type === "worker") return [];
  const failed = task.state === "failed";
  if (failed && (await settledFailedBefore(db, task))) return [];
  const opKey = settleOpKey(run.run_id, task.task_id, status);
  const { operation } = await db.insertOperation({
    op_key: opKey,
    intent: "task_update",
    owner_generation: run.owner_generation,
    at: ctx.now(),
  });
  if (operation.status === "done") return [];
  const retryRequest =
    operation.status === "unknown"
      ? (OpenRequest.safeParse(operation.result_ref).data?.requestId ??
        undefined)
      : undefined;
  log.at({ run_id: run.run_id, task_id: task.task_id, op_key: opKey });
  const receipt = await orca.taskUpdate({
    task: task.task_id,
    status,
    ...(failed ? { result: `${step.gate ?? step.id} FAIL` } : {}),
    run: run.run_id,
    from: run.coordinator,
    ...(retryRequest === undefined ? {} : { retryRequest }),
  });
  const outcome = settleOutcome(receipt);
  const at = ctx.now();
  if (outcome.kind === "ok") {
    await db.moveOperation(
      opKey,
      "done",
      { task_id: task.task_id, status },
      at,
    );
    return [];
  }
  const recheck = `pod check --run ${run.run_id} --generation ${run.owner_generation}`;
  if (operation.status === "pending")
    await db.moveOperation(
      opKey,
      outcome.kind === "unknown" ? "unknown" : "pending",
      outcome.kind === "unknown"
        ? { verb: "task-update", requestId: outcome.requestId }
        : failure("task-update", receipt.raw, receipt.exitCode),
      at,
    );
  if (outcome.kind === "unknown") return [recheck];
  return [
    recheck,
    `task-update for Task ${task.task_id} failed with exit ${receipt.exitCode}; pod check sends it again`,
  ];
}

export async function settleRun(
  ctx: SettleContext,
  run: Run,
): Promise<string[]> {
  const lines: string[] = [];
  for (const task of await ctx.db.listTasks(run.run_id))
    if (runtimeStatus[task.state] !== undefined)
      lines.push(...(await settleRuntime(ctx, run, task.task_id)));
  return lines;
}
