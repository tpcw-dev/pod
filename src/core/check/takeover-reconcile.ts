import { Json } from "../domain/json.ts";
import type { Operation, Run } from "../domain/ledger.ts";
import { launchOutcome } from "../ledger/launch.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  checkStep,
  recordTakeover,
  TakeoverRecorded,
  type TakeoverRequest,
} from "../run/takeover.ts";
import { fence } from "./fence.ts";

export interface TakeoverReconcileInput {
  run: Run;
  generation: number;
  host: string;
  now: () => Date;
}

export async function reconcileTakeovers(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: TakeoverReconcileInput,
): Promise<string[] | null> {
  for (const operation of await db.listOperations(
    ["takeover"],
    ["pending", "unknown"],
  )) {
    const ref = TakeoverRecorded.safeParse(operation.result_ref);
    if (!ref.success || ref.data.request.run_id !== input.run.run_id) continue;
    if (ref.data.request.generation !== input.run.owner_generation) {
      await close(db, input, operation.op_key, ref.data.request, "superseded");
      continue;
    }
    log.at({
      run_id: input.run.run_id,
      task_id: null,
      op_key: operation.op_key,
    });
    return reconcileOne(
      db,
      orca,
      input,
      operation,
      ref.data.request,
      ref.data.requestId ?? null,
    );
  }
  return null;
}

async function reconcileOne(
  db: Db,
  orca: OrcaPort,
  input: TakeoverReconcileInput,
  operation: Operation,
  request: TakeoverRequest,
  requestId: string | null,
): Promise<string[]> {
  const opKey = operation.op_key;
  const runId = input.run.run_id;
  const nextAttempt = [
    `pod takeover story:${request.story} --generation ${request.generation}`,
    checkStep(runId, input.generation),
  ];
  const stillOpen = [
    `pod check: takeover ${opKey} is still ${operation.status}`,
    checkStep(runId, input.generation),
  ];
  const record = async (consumerGeneration: number) => {
    const recorded = await recordTakeover(db, {
      opKey,
      request,
      consumerGeneration,
      host: input.host,
      verb: "check",
      at: input.now(),
    });
    if (recorded.kind === "refused") return recorded.refusal.nextSteps;
    return [
      checkStep(runId, recorded.taken.owner_generation),
      `pod takeover story:${request.story} --generation ${request.generation} --op-key ${opKey}`,
    ];
  };

  if (requestId === null) {
    const shown = await orca.runShow({ run: runId });
    const bound = shown.result?.run;
    if (shown.exitCode !== 0 || bound === undefined) return stillOpen;
    if (bound.coordinator_handle === request.to_handle)
      return record(bound.consumer_generation);
    await close(db, input, opKey, request, "not_bound");
    return nextAttempt;
  }

  const state = (await orca.requestShow({ request: requestId })).result?.state;
  if (state === "completed") {
    const receipt = await orca.runUse({
      run: runId,
      from: request.to_handle,
      retryRequest: requestId,
    });
    if (launchOutcome(receipt).kind === "ok" && receipt.result !== null)
      return record(receipt.result.run.consumer_generation);
    return stillOpen;
  }
  if (state !== "absent") return stillOpen;
  await close(db, input, opKey, request, "absent");
  return nextAttempt;
}

async function close(
  db: Db,
  input: TakeoverReconcileInput,
  opKey: string,
  request: TakeoverRequest,
  reconciled: "absent" | "not_bound" | "superseded",
): Promise<void> {
  await db.transaction(async (tx) => {
    await fence(tx, input.run.run_id, input.generation);
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "failed", reconciled }),
      input.now(),
    );
  });
}
