import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Run } from "../domain/ledger.ts";
import { errorCode } from "../dispatch/stop.ts";
import { launchOutcome } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaMessage, OrcaPort, WorkerRow } from "../ports/orca.ts";
import { fence } from "./fence.ts";

export interface FollowUp {
  dispatchId: string;
  parent: string;
  workerState: string;
}

export function parentByTerminal(
  handle: string | null | undefined,
  dispatches: readonly Dispatch[],
): string | null {
  if (handle == null) return null;
  let parent: Dispatch | null = null;
  for (const row of dispatches)
    if (
      row.terminal_handle === handle &&
      (parent === null || row.created_at > parent.created_at)
    )
      parent = row;
  return parent?.dispatch_id ?? null;
}

export function followUpParent(
  row: WorkerRow,
  dispatches: readonly Dispatch[],
): string | null {
  const parent = parentByTerminal(row.agentTerminalHandle, dispatches);
  if (parent === null) return null;
  return row.followUpOf == null || row.followUpOf === parent ? parent : null;
}

const LaunchPayload = z.looseObject({ follow_up_of: z.string().optional() });

export async function messageFollowUp(
  tx: Repo,
  run: Run,
  message: OrcaMessage,
): Promise<string | null> {
  const id = message.payload.dispatchId;
  if (id === undefined) return null;
  const launch = await tx.dispatchEvent(id, "unknown_launch");
  if (launch !== null)
    return launch.run_id === run.run_id
      ? (LaunchPayload.safeParse(launch.payload).data?.follow_up_of ?? null)
      : null;
  return parentByTerminal(
    message.from_handle,
    await tx.listDispatches(run.run_id),
  );
}

const StopPayload = z.looseObject({
  outcome: z.enum(["stopped", "unknown"]),
  request_id: z.string().nullish(),
});

const endedStates = ["stopped", "succeeded"];

export interface StopFollowUpsInput {
  run: Run;
  generation: number;
  host: string;
  now: () => Date;
  followUps: readonly FollowUp[];
}

export async function stopFollowUps(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: StopFollowUpsInput,
): Promise<string[]> {
  const steps: string[] = [];
  for (const followUp of input.followUps) {
    const step = await stopFollowUp(db, orca, log, input, followUp);
    if (step !== null) steps.push(step);
  }
  return steps;
}

async function stopFollowUp(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: StopFollowUpsInput,
  followUp: FollowUp,
): Promise<string | null> {
  const { run } = input;
  const id = followUp.dispatchId;
  const opKey = derivedOpKey("stop", {
    run_id: run.run_id,
    dispatch_id: id,
  });
  const named = `follow-up ${id} of ${followUp.parent}`;
  const record = (outcome: string, evidence: Record<string, Json>) =>
    db.transaction(async (tx) => {
      await fence(tx, run.run_id, input.generation);
      await tx.appendEvent({
        type: "stop",
        ts: input.now(),
        host: input.host,
        run_id: run.run_id,
        task_id: null,
        dispatch_id: id,
        op_key: opKey,
        payload: Json.parse({
          follow_up_of: followUp.parent,
          outcome,
          ...evidence,
        }),
        source: { kind: "command", verb: "check" },
      });
    });
  const stopped = async (evidence: Record<string, Json>) => {
    await record("stopped", evidence);
    return `${named} stopped; resend to an open Dispatch if the message still matters`;
  };
  const unknown = (requestId: string | null) =>
    `worker-stop of ${named} has no known outcome; pod check settles it from ${requestId === null ? "" : `request ${requestId} or `}the worker list`;

  const latest = await db.latestEvent(run.run_id, "stop", { dispatchId: id });
  const prior =
    latest === null
      ? null
      : (StopPayload.safeParse(latest.payload).data ?? null);
  if (prior?.outcome === "stopped") return null;
  if (endedStates.includes(followUp.workerState))
    return stopped({ worker_state: followUp.workerState });
  const context = { run_id: run.run_id, task_id: null, op_key: opKey };
  if (prior?.outcome === "unknown") {
    const requestId = prior.request_id ?? null;
    if (requestId === null) return unknown(null);
    log.at(context);
    const shown = await orca.requestShow({ request: requestId });
    const state = shown.result?.state;
    if (state === "completed") return stopped({ request_id: requestId });
    if (state !== "absent") return unknown(requestId);
  }
  await db.transaction((tx) => fence(tx, run.run_id, input.generation));
  log.at(context);
  const receipt = await orca.workerStop({ dispatch: id });
  if (receipt.exitCode === 0 && receipt.result?.state === "stopped")
    return stopped({ receipt: Json.parse(receipt.result) });
  const outcome = launchOutcome(receipt);
  if (outcome.kind === "failed")
    return `worker-stop of ${named} failed: ${errorCode(receipt.raw)}; run pod check again`;
  const requestId = outcome.kind === "unknown" ? outcome.requestId : null;
  await record("unknown", { request_id: requestId });
  return unknown(requestId);
}
