import { z } from "zod";
import { HoldPayload, latestDispatch, resumeTarget } from "../domain/hold.ts";
import { Json } from "../domain/json.ts";
import type { Operation, Run } from "../domain/ledger.ts";
import {
  fromReceipt,
  LaunchArgs,
  recordStarted,
  type Launched,
} from "../dispatch/launch-record.ts";
import { launchOutcome } from "../ledger/launch.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt, WorkerRow } from "../ports/orca.ts";
import { fence } from "./fence.ts";

const UnknownRef = z.looseObject({
  request: z.looseObject({
    task_id: z.string(),
    seat: z.string(),
    host: z.string(),
    retry_of: z.string().exactOptional(),
  }),
  launch: LaunchArgs.optional().catch(undefined),
  requestId: z.string().nullish(),
  manifest_id: z.string(),
});
type UnknownRef = z.infer<typeof UnknownRef>;

const freshCodes = ["orca_version_unsupported", "consumer_fenced"];

const RecordedRefusal = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({ code: z.string().min(1) }),
});

export const launchLeaseSeconds = 300;

export interface Reconciled {
  op_key: string;
  to: string;
}

export interface ReconcileInput {
  run: Run;
  generation: number;
  workers: () => Promise<WorkerRow[] | null>;
  now: () => Date;
  leaseSeconds: number;
}

interface Outcome {
  to: Reconciled["to"];
  nextStep?: string;
}

export async function reconcileLaunches(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReconcileInput,
): Promise<{ reconciled: Reconciled[]; nextSteps: string[] }> {
  const tasks = new Set(
    (await db.listTasks(input.run.run_id)).map((task) => task.task_id),
  );
  const leaseStart = input.now().getTime() - input.leaseSeconds * 1000;
  const reconciled: Reconciled[] = [];
  const nextSteps: string[] = [];
  for (const operation of await db.listOperations(
    ["dispatch", "retry"],
    ["unknown", "pending"],
  )) {
    if (
      operation.status === "pending" &&
      operation.updated_at.getTime() >= leaseStart
    )
      continue;
    const ref = UnknownRef.safeParse(operation.result_ref);
    if (!ref.success) {
      nextSteps.push(unreadableLine(operation, ref.error));
      continue;
    }
    if (!tasks.has(ref.data.request.task_id)) continue;
    const outcome = await reconcileOne(
      db,
      orca,
      log,
      input,
      operation,
      ref.data,
    );
    if (outcome === null) continue;
    reconciled.push({ op_key: operation.op_key, to: outcome.to });
    if (outcome.nextStep !== undefined) nextSteps.push(outcome.nextStep);
  }
  return { reconciled, nextSteps };
}

function unreadableLine(operation: Operation, error: z.ZodError): string {
  const path = error.issues[0]?.path.join(".") ?? "";
  return `pod check: launch ${operation.op_key} has an unreadable request (${path}) and holds a slot; inspect ledger.operation ${operation.op_key}`;
}

function leaseLine(input: ReconcileInput, operation: Operation): string {
  return `pod check: launch ${operation.op_key} was pending past the ${input.leaseSeconds}-second lease`;
}

async function reconcileOne(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReconcileInput,
  operation: Operation,
  ref: UnknownRef,
): Promise<Outcome | null> {
  const { request, launch } = ref;
  const runId = input.run.run_id;
  const abandoned = operation.status === "pending";
  log.at({ run_id: runId, task_id: request.task_id, op_key: operation.op_key });
  let shown: string | null = null;
  let refused: string | null = null;
  if (ref.requestId != null) {
    shown =
      (await orca.requestShow({ request: ref.requestId })).result?.state ??
      null;
    if (shown === "completed" && launch !== undefined) {
      const receipt = await orca.workerStart({
        task: request.task_id,
        run: runId,
        ...launch,
        retryRequest: ref.requestId,
      });
      const launched =
        launchOutcome(receipt).kind === "ok" && receipt.result !== null
          ? fromReceipt(receipt.result)
          : null;
      if (launched !== null)
        return (await started(db, input, operation, ref, launched))
          ? { to: "dispatched" }
          : null;
      refused = recordedRefusal(receipt);
    }
  }
  const rows = await input.workers();
  if (rows === null)
    return abandoned
      ? {
          to: "pending",
          nextStep: `${leaseLine(input, operation)}; the worker list was unreadable, run pod check again`,
        }
      : { to: "unknown" };
  const candidates = rows.filter((row) => row.taskId === request.task_id);
  for (const row of candidates) {
    if ((await db.getDispatch(row.dispatchId)) !== null) continue;
    const recorded = await started(db, input, operation, ref, {
      dispatchId: row.dispatchId,
      terminalHandle: null,
      requested: null,
      effective: null,
      worktreeId: row.resource?.worktreeId ?? null,
    });
    if (!recorded) return null;
    return abandoned
      ? {
          to: "dispatched",
          nextStep: `${leaseLine(input, operation)}; recorded Dispatch ${row.dispatchId}`,
        }
      : { to: "dispatched" };
  }
  if (ref.requestId != null && shown !== "absent" && refused === null)
    return { to: "unknown" };
  const at = input.now();
  const closed = await db.transaction(async (tx) => {
    if (!(await claim(tx, input, operation, ref))) return null;
    await tx.moveOperation(
      operation.op_key,
      "done",
      Json.parse({
        request,
        launch: launch ?? null,
        outcome: "failed",
        ...(refused === null
          ? { reconciled: abandoned ? "lease_no_worker" : "no_worker" }
          : { reconciled: "recorded_refusal", code: refused }),
      }),
      at,
    );
    const task = await tx.getTask(request.task_id);
    if (abandoned || task?.state !== "hold")
      return { state: task?.state ?? "missing" };
    const hold = await tx.latestEvent(runId, "hold", {
      taskId: request.task_id,
    });
    const to = resumeTarget(
      hold === null
        ? undefined
        : HoldPayload.safeParse(hold.payload).data?.from,
      latestDispatch(await tx.listDispatches(runId), request.task_id),
    );
    await tx.setTaskState(request.task_id, to);
    await tx.appendEvent({
      type: "resume",
      ts: at,
      host: request.host,
      run_id: runId,
      task_id: request.task_id,
      dispatch_id: null,
      op_key: operation.op_key,
      payload: { reason: "reconciled_no_worker", op_key: operation.op_key, to },
      source: { kind: "command", verb: "check" },
    });
    return { state: to };
  });
  if (closed === null) return null;
  if (!abandoned) return { to: closed.state };
  return {
    to: "closed",
    nextStep: `${leaseLine(input, operation)}; closed with no worker, Task ${request.task_id} is ${closed.state}`,
  };
}

async function claim(
  tx: Repo,
  input: ReconcileInput,
  operation: Operation,
  ref: UnknownRef,
): Promise<boolean> {
  await fence(tx, input.run.run_id, input.generation);
  await tx.lockQuota(ref.request.host);
  return (await tx.getOperation(operation.op_key))?.status === operation.status;
}

function recordedRefusal(receipt: Receipt<unknown>): string | null {
  if (launchOutcome(receipt).kind !== "failed") return null;
  const parsed = RecordedRefusal.safeParse(receipt.raw);
  if (!parsed.success) return null;
  const { code } = parsed.data.error;
  return freshCodes.includes(code) ? null : code;
}

async function started(
  db: Db,
  input: ReconcileInput,
  operation: Operation,
  ref: UnknownRef,
  launched: Launched,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await claim(tx, input, operation, ref))) return false;
    const task = await tx.getTask(ref.request.task_id);
    if (task === null) throw new Error(`Task ${ref.request.task_id} vanished`);
    await recordStarted(tx, {
      opKey: operation.op_key,
      request: ref.request,
      launch: ref.launch ?? null,
      task,
      manifestId: ref.manifest_id,
      generation: operation.owner_generation,
      launched,
      verb: "check",
      at: input.now(),
    });
    return true;
  });
}
