import { z } from "zod";
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
import type { Db } from "../ports/db.ts";
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

export interface Reconciled {
  op_key: string;
  to: "dispatched" | "ready" | "unknown";
}

export interface ReconcileInput {
  run: Run;
  generation: number;
  workers: () => Promise<WorkerRow[] | null>;
  now: () => Date;
}

export async function reconcileLaunches(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReconcileInput,
): Promise<Reconciled[]> {
  const tasks = new Set(
    (await db.listTasks(input.run.run_id)).map((task) => task.task_id),
  );
  const done: Reconciled[] = [];
  for (const operation of await db.listOperations(
    ["dispatch", "retry"],
    ["unknown"],
  )) {
    const ref = UnknownRef.safeParse(operation.result_ref);
    if (!ref.success || !tasks.has(ref.data.request.task_id)) continue;
    done.push({
      op_key: operation.op_key,
      to: await reconcileOne(db, orca, log, input, operation, ref.data),
    });
  }
  return done;
}

async function reconcileOne(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReconcileInput,
  operation: Operation,
  ref: UnknownRef,
): Promise<Reconciled["to"]> {
  const { request, launch } = ref;
  const runId = input.run.run_id;
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
      if (launched !== null) {
        await started(db, input, operation, ref, launched);
        return "dispatched";
      }
      refused = recordedRefusal(receipt);
    }
  }
  const rows = await input.workers();
  if (rows === null) return "unknown";
  const candidates = rows.filter((row) => row.taskId === request.task_id);
  for (const row of candidates) {
    if ((await db.getDispatch(row.dispatchId)) !== null) continue;
    await started(db, input, operation, ref, {
      dispatchId: row.dispatchId,
      terminalHandle: null,
      requested: null,
      effective: null,
      worktreeId: row.resource?.worktreeId ?? null,
    });
    return "dispatched";
  }
  if (ref.requestId != null && shown !== "absent" && refused === null)
    return "unknown";
  const at = input.now();
  await db.transaction(async (tx) => {
    await fence(tx, runId, input.generation);
    await tx.moveOperation(
      operation.op_key,
      "done",
      Json.parse({
        request,
        launch: launch ?? null,
        outcome: "failed",
        ...(refused === null
          ? { reconciled: "no_worker" }
          : { reconciled: "recorded_refusal", code: refused }),
      }),
      at,
    );
    const task = await tx.getTask(request.task_id);
    if (task?.state !== "hold") return;
    await tx.setTaskState(request.task_id, "ready");
    await tx.appendEvent({
      type: "resume",
      ts: at,
      host: request.host,
      run_id: runId,
      task_id: request.task_id,
      dispatch_id: null,
      op_key: operation.op_key,
      payload: { reason: "reconciled_no_worker", op_key: operation.op_key },
      source: { kind: "command", verb: "check" },
    });
  });
  return "ready";
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
): Promise<void> {
  await db.transaction(async (tx) => {
    await fence(tx, input.run.run_id, input.generation);
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
  });
}
