import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Task } from "../domain/ledger.ts";
import { launchOutcome } from "../ledger/launch.ts";
import { moveTask } from "../ledger/move-task.ts";
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
  nextSteps?: string[];
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

export function attribution(launched: Launched): "receipt" | "unknown" {
  const model =
    ModelField.parse(launched.effective)?.model ??
    ModelField.parse(launched.requested)?.model;
  return typeof model === "string" && model !== "" ? "receipt" : "unknown";
}

export function requestedLaunch(
  launched: Launched,
  launch: LaunchArgs | null,
): Json {
  const { requested, worktreeId } = launched;
  const base: Record<string, unknown> = {
    ...(requested !== null && typeof requested === "object"
      ? requested
      : launch),
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
  await moveTask(tx, input.task.task_id, "dispatched");
  await insertTaskStart(tx, input, done, false);
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
    await moveTask(tx, input.task.task_id, "dispatched");
  await insertTaskStart(tx, input, done, true);
  const nextSteps = (await tx.listDispatches(done.run_id))
    .filter(
      (sibling) =>
        sibling.task_id === done.task_id &&
        sibling.settlement === "open" &&
        sibling.dispatch_id !== done.dispatch_id,
    )
    .map(
      (sibling) =>
        `late start ${done.dispatch_id} (launch ${input.opKey}) joins open Dispatch ${sibling.dispatch_id} (launch ${sibling.op_key}) on Task ${done.task_id}; release one with pod release`,
    );
  return nextSteps.length === 0 ? done : { ...done, nextSteps };
}

export type DispatchOwner =
  | { task_id: string; decision_id: null }
  | { task_id: null; decision_id: string };

export interface StartRow {
  owner: DispatchOwner;
  run_id: string;
  role: string;
  seat: string;
  host: string;
  launched: Launched;
  requested_launch: Json;
  model_attribution: "receipt" | "unknown";
  retry_of: string | null;
  fallback_of?: string | null;
  op_key: string;
  manifest_id: string;
  verb: string;
  late: boolean;
  at: Date;
}

export async function insertStart(tx: Repo, start: StartRow): Promise<void> {
  const { launched, owner } = start;
  const row: Dispatch = {
    dispatch_id: launched.dispatchId,
    task_id: owner.task_id,
    decision_id: owner.decision_id,
    run_id: start.run_id,
    seat: start.seat,
    role: start.role,
    requested_launch: start.requested_launch,
    effective_launch: Json.parse(launched.effective),
    model_attribution: start.model_attribution,
    retry_of: start.retry_of,
    op_key: start.op_key,
    settlement: "open",
    terminal_handle: launched.terminalHandle,
    created_at: start.at,
    settled_at: null,
    activity: "running",
    manifest_id: start.manifest_id,
  };
  await tx.insertDispatch(row);
  const event = (type: "start" | "retry") =>
    tx.appendEvent({
      type,
      ts: start.at,
      host: start.host,
      run_id: start.run_id,
      task_id: owner.task_id,
      dispatch_id: launched.dispatchId,
      op_key: start.op_key,
      payload: {
        seat: start.seat,
        role: start.role,
        manifest_id: start.manifest_id,
        ...(owner.decision_id === null
          ? {}
          : { decision_id: owner.decision_id }),
        ...(start.retry_of === null ? {} : { retry_of: start.retry_of }),
        ...(start.fallback_of == null
          ? {}
          : { fallback_of: start.fallback_of }),
        ...(start.late ? { late: true } : {}),
      },
      source: { kind: "command", verb: start.verb },
    });
  await event("start");
  if (start.verb === "retry") await event("retry");
}

async function insertTaskStart(
  tx: Repo,
  input: StartedInput,
  done: DispatchResult,
  late: boolean,
): Promise<void> {
  await insertStart(tx, {
    owner: { task_id: input.task.task_id, decision_id: null },
    run_id: input.task.run_id,
    role: input.task.role,
    seat: input.request.seat,
    host: input.request.host,
    launched: input.launched,
    requested_launch: requestedLaunch(input.launched, input.launch),
    model_attribution: done.model_attribution,
    retry_of: input.request.retry_of ?? null,
    op_key: input.opKey,
    manifest_id: input.manifestId,
    verb: input.verb,
    late,
    at: input.at,
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
  await moveTask(tx, input.task.task_id, "hold");
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
