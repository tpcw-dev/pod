import { Json } from "../domain/json.ts";
import type { Dispatch } from "../domain/ledger.ts";
import { launchOutcome } from "../ledger/launch.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort, WorkerRow } from "../ports/orca.ts";

export interface StopInput {
  dispatch: Dispatch;
  decisionId: string;
  requestId: string | null;
  unknown: boolean;
  workers: () => Promise<WorkerRow[] | null>;
  host: string;
  now: () => Date;
}

export type StopOutcome =
  | { kind: "settled" }
  | {
      kind: "wait";
      message: string;
      requestId: string | null;
      unknown: boolean;
    };

export async function stopForSupersede(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: StopInput,
): Promise<StopOutcome> {
  const { dispatch } = input;
  const id = dispatch.dispatch_id;
  const settled = async (
    evidence: Record<string, Json>,
  ): Promise<StopOutcome> => {
    await db.transaction(async (tx) => {
      const at = input.now();
      const moved = await tx.settleDispatch(id, {
        activity: "settled",
        settlement: "superseded",
        settled_at: at,
      });
      if (!moved) return;
      await tx.appendEvent({
        type: "stop",
        ts: at,
        host: input.host,
        run_id: dispatch.run_id,
        task_id: dispatch.task_id,
        dispatch_id: id,
        op_key: null,
        payload: Json.parse({ decision_id: input.decisionId, ...evidence }),
        source: { kind: "command", verb: "check" },
      });
    });
    return { kind: "settled" };
  };
  const wait = (
    message: string,
    requestId = input.requestId,
    unknown = input.unknown,
  ): StopOutcome => ({ kind: "wait", message, requestId, unknown });

  const row = (await input.workers())?.find((item) => item.dispatchId === id);
  if (row?.workerState === "stopped")
    return settled({ worker_state: row.workerState });
  let requestId = input.requestId;
  const context = {
    run_id: dispatch.run_id,
    task_id: dispatch.task_id,
    op_key: null,
  };
  if (requestId !== null) {
    log.at(context);
    const shown = await orca.requestShow({ request: requestId });
    const state = shown.result?.state;
    if (state === "completed") return settled({ request_id: requestId });
    if (state !== "absent")
      return wait(
        `worker-stop of Dispatch ${id} is ${state ?? "unreadable"} (request ${requestId}); run pod check again`,
      );
    requestId = null;
  }
  if (input.unknown)
    return wait(
      `worker-stop of Dispatch ${id} has no known outcome; pod check settles it when worker-list shows it stopped`,
    );
  log.at(context);
  const receipt = await orca.workerStop({ dispatch: id });
  if (receipt.exitCode === 0 && receipt.result !== null)
    return settled({ receipt: Json.parse(receipt.result) });
  const outcome = launchOutcome(receipt);
  if (outcome.kind === "unknown")
    return outcome.requestId === null
      ? wait(
          `worker-stop of Dispatch ${id} has no known outcome; pod check settles it when worker-list shows it stopped`,
          null,
          true,
        )
      : wait(
          `worker-stop of Dispatch ${id} has no known outcome (request ${outcome.requestId}); run pod check again`,
          outcome.requestId,
          false,
        );
  return wait(
    `worker-stop of Dispatch ${id} failed: ${errorCode(receipt.raw)}; run pod check again`,
    null,
    false,
  );
}

function errorCode(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || !("error" in raw))
    return "no readable reply";
  const { error } = raw;
  if (typeof error !== "object" || error === null || !("code" in error))
    return "no error code";
  return String(error.code);
}
