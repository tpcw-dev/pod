import { z } from "zod";
import { capacityMissing } from "../config/host.ts";
import type { Checked } from "../domain/outcome.ts";
import { hostFreeSlots } from "../dispatch/quota.ts";
import { stopDispatch } from "../dispatch/stop.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort, WorkerRow } from "../ports/orca.ts";
import { listAllWorkers, listWorkers } from "./workers.ts";

const WorkerRun = z.looseObject({ worker_run: z.string().min(1) });

export interface RunlessInput {
  host: string;
  capacity: number | null;
  now: () => Date;
}

export interface RunlessObserved {
  run_id: null;
  stopped: string[];
  unknown_workers: string[];
  free_slots: number;
  nextSteps: string[];
}

/**
 * Observes this host's open Dispatches with no Run: a worker the worker
 * runtime shows stopped settles its Dispatch, and a Dispatch the worker list
 * does not show is listed under unknown_workers and left open. A Dispatch
 * that recorded its worker Run is listed by that Run, so the binding of the
 * calling terminal does not matter for it.
 */
export async function observeRunless(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: RunlessInput,
): Promise<Checked<RunlessObserved>> {
  const { version } = await orca.version();
  const result: RunlessObserved = {
    run_id: null,
    stopped: [],
    unknown_workers: [],
    free_slots: 0,
    nextSteps: [],
  };
  const open = await db.openRunlessDispatches(input.host);
  let unscoped: Promise<{ rows: WorkerRow[] } | { scope: string }> | null =
    null;
  for (const dispatch of open) {
    const workerRun = WorkerRun.safeParse(dispatch.requested_launch).data
      ?.worker_run;
    let rows: WorkerRow[] | null;
    if (workerRun === undefined) {
      const listed = await (unscoped ??= listAllWorkers(orca));
      if ("scope" in listed) {
        const line = `worker-list without --run did not cover every Run (scope ${listed.scope}); run pod check --observe from a terminal bound to no Run`;
        if (!result.nextSteps.includes(line)) result.nextSteps.push(line);
        continue;
      }
      rows = listed.rows;
    } else rows = await listWorkers(orca, workerRun);
    const row = rows?.find((item) => item.dispatchId === dispatch.dispatch_id);
    if (row === undefined) result.unknown_workers.push(dispatch.dispatch_id);
    else if (row.workerState === "stopped") {
      await stopDispatch(db, orca, log, {
        dispatch,
        cause: { reason: "worker_stopped" },
        requestId: null,
        unknown: false,
        workers: () => Promise.resolve(rows),
        host: input.host,
        now: input.now,
      });
      result.stopped.push(dispatch.dispatch_id);
    }
  }
  if (input.capacity === null) {
    const missing = capacityMissing(input.host);
    result.nextSteps.push(missing.message, ...missing.nextSteps);
  } else
    result.free_slots = await hostFreeSlots(db, input.host, input.capacity);
  return { ok: true, result, orca: version };
}
