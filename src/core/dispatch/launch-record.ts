import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Task } from "../domain/ledger.ts";
import { launchOutcome } from "../ledger/launch.ts";
import type { Db, Repo } from "../ports/db.ts";
import type {
  Receipt,
  WorkerStartRequest,
  WorkerStartResult,
} from "../ports/orca.ts";

export type LaunchArgs = Omit<WorkerStartRequest, "task" | "spec" | "run">;

export const LaunchArgs = z.looseObject({
  agent: z.string().min(1),
  model: z.string().exactOptional(),
  effort: z.string().exactOptional(),
  worktree: z.string().exactOptional(),
  retryOf: z.string().exactOptional(),
});

export interface LaunchRequest {
  task_id: string;
  seat: string;
  host: string;
  retry_of?: string;
}

export interface DispatchResult {
  dispatch_id: string;
  task_id: string;
  run_id: string;
  seat: string;
  manifest_id: string;
  model_attribution: "receipt" | "unknown";
  terminal_handle: string | null;
  owner_generation: number;
}

export interface Launched {
  dispatchId: string;
  terminalHandle: string | null;
  requested: unknown;
  effective: unknown;
  worktreeId: string | null;
}

export interface StartedInput {
  opKey: string;
  request: LaunchRequest;
  launch: LaunchArgs | null;
  task: Pick<Task, "task_id" | "run_id" | "role">;
  manifestId: string;
  generation: number;
  launched: Launched;
  verb: string;
  at: Date;
}

export function fromReceipt(result: WorkerStartResult): Launched | null {
  if (typeof result.dispatchId !== "string") return null;
  const worktree = result.effects?.find((effect) => effect.kind === "worktree");
  return {
    dispatchId: result.dispatchId,
    terminalHandle: result.terminalHandle ?? null,
    requested: result.launch?.requested ?? null,
    effective: result.launch?.effective ?? null,
    worktreeId: worktree?.id ?? null,
  };
}

const ModelField = z.looseObject({ model: z.unknown() }).nullish().catch(null);

function attribution(launched: Launched): "receipt" | "unknown" {
  const model =
    ModelField.parse(launched.effective)?.model ??
    ModelField.parse(launched.requested)?.model;
  return typeof model === "string" && model !== "" ? "receipt" : "unknown";
}

function requestedLaunch(input: StartedInput): Json {
  const { requested, worktreeId } = input.launched;
  const base: Record<string, unknown> = {
    ...(requested !== null && typeof requested === "object"
      ? requested
      : input.launch),
  };
  if (worktreeId !== null) base["worktree"] = `id:${worktreeId}`;
  return Json.parse(base);
}

function dispatchResult(input: StartedInput): DispatchResult {
  const { launched, task } = input;
  return {
    dispatch_id: launched.dispatchId,
    task_id: task.task_id,
    run_id: task.run_id,
    seat: input.request.seat,
    manifest_id: input.manifestId,
    model_attribution: attribution(launched),
    terminal_handle: launched.terminalHandle,
    owner_generation: input.generation,
  };
}

export async function recordStarted(
  tx: Repo,
  input: StartedInput,
): Promise<DispatchResult> {
  const done = dispatchResult(input);
  await tx.moveOperation(
    input.opKey,
    "done",
    Json.parse({
      request: input.request,
      launch: input.launch,
      manifest_id: input.manifestId,
      result: done,
    }),
    input.at,
  );
  await tx.setTaskState(input.task.task_id, "dispatched");
  await insertStart(tx, input, done, false);
  return done;
}

export async function recordLate(
  tx: Repo,
  input: StartedInput,
): Promise<DispatchResult> {
  const done = dispatchResult(input);
  if ((await tx.getDispatch(done.dispatch_id)) !== null) return done;
  const left = input.request.retry_of === undefined ? "ready" : "blocked";
  if ((await tx.getTask(input.task.task_id))?.state === left)
    await tx.setTaskState(input.task.task_id, "dispatched");
  await insertStart(tx, input, done, true);
  return done;
}

async function insertStart(
  tx: Repo,
  input: StartedInput,
  done: DispatchResult,
  late: boolean,
): Promise<void> {
  const { launched, task, request } = input;
  const row: Dispatch = {
    dispatch_id: launched.dispatchId,
    task_id: task.task_id,
    run_id: task.run_id,
    seat: request.seat,
    role: task.role,
    requested_launch: requestedLaunch(input),
    effective_launch: Json.parse(launched.effective),
    model_attribution: done.model_attribution,
    retry_of: request.retry_of ?? null,
    op_key: input.opKey,
    settlement: "open",
    terminal_handle: launched.terminalHandle,
    created_at: input.at,
    settled_at: null,
    activity: "running",
    manifest_id: input.manifestId,
  };
  await tx.insertDispatch(row);
  await tx.appendEvent({
    type: "start",
    ts: input.at,
    host: request.host,
    run_id: task.run_id,
    task_id: task.task_id,
    dispatch_id: launched.dispatchId,
    op_key: input.opKey,
    payload: {
      seat: request.seat,
      role: task.role,
      manifest_id: input.manifestId,
      ...(request.retry_of === undefined ? {} : { retry_of: request.retry_of }),
      ...(late ? { late: true } : {}),
    },
    source: { kind: "command", verb: input.verb },
  });
}

export interface UnknownInput {
  opKey: string;
  request: LaunchRequest;
  launch: LaunchArgs;
  task: Pick<Task, "task_id" | "run_id">;
  manifestId: string;
  requestId: string | null;
  verb: string;
  at: Date;
}

export async function recordUnknown(
  tx: Repo,
  input: UnknownInput,
): Promise<void> {
  await tx.moveOperation(
    input.opKey,
    "unknown",
    Json.parse({
      request: input.request,
      launch: input.launch,
      requestId: input.requestId,
      manifest_id: input.manifestId,
    }),
    input.at,
  );
  const from = (await tx.getTask(input.task.task_id))?.state;
  await tx.setTaskState(input.task.task_id, "hold");
  await tx.appendEvent({
    type: "hold",
    ts: input.at,
    host: input.request.host,
    run_id: input.task.run_id,
    task_id: input.task.task_id,
    dispatch_id: null,
    op_key: input.opKey,
    payload: {
      reason: "launch_unknown",
      op_key: input.opKey,
      ...(from === undefined ? {} : { from }),
    },
    source: { kind: "command", verb: input.verb },
  });
}

export type ReceiptInput = Omit<StartedInput, "launched" | "launch"> & {
  launch: LaunchArgs;
  receipt: Receipt<WorkerStartResult>;
};

export type Recorded =
  | { kind: "started"; done: DispatchResult }
  | { kind: "failed" }
  | { kind: "unknown" };

export async function recordReceipt(
  db: Db,
  input: ReceiptInput,
): Promise<Recorded> {
  const { receipt, ...rest } = input;
  const outcome = launchOutcome(receipt);
  const launched =
    outcome.kind === "ok" && receipt.result !== null
      ? fromReceipt(receipt.result)
      : null;
  return db.transaction(async (tx): Promise<Recorded> => {
    await tx.lockQuota(input.request.host);
    const pending = (await tx.getOperation(input.opKey))?.status === "pending";
    if (launched !== null) {
      const started = { ...rest, launched };
      return {
        kind: "started",
        done: pending
          ? await recordStarted(tx, started)
          : await recordLate(tx, started),
      };
    }
    if (outcome.kind === "failed") {
      if (pending)
        await tx.moveOperation(
          input.opKey,
          "done",
          Json.parse({
            request: input.request,
            outcome: "failed",
            raw: receipt.raw ?? null,
          }),
          input.at,
        );
      return { kind: "failed" };
    }
    if (pending)
      await recordUnknown(tx, {
        ...rest,
        requestId: outcome.kind === "unknown" ? outcome.requestId : null,
      });
    return { kind: "unknown" };
  });
}
