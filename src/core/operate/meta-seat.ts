import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { singleActive } from "../config/active.ts";
import { sha256Hex } from "../config/canonical-json.ts";
import { listWorkers } from "../check/workers.ts";
import { seatLaunch } from "../dispatch/dispatch.ts";
import { slotRefusal } from "../dispatch/launch-gate.ts";
import {
  attribution,
  fromReceipt,
  insertStart,
  LaunchArgs,
  requestedLaunch,
  type Launched,
} from "../dispatch/launch-record.ts";
import { openLaunches } from "../dispatch/quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "../dispatch/seats.ts";
import { errorCode } from "../dispatch/stop.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch } from "../domain/ledger.ts";
import type { Refusal } from "../domain/outcome.ts";
import { launchOutcome } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { hostCapacity } from "../plan/capacity.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt, WorkerStartResult } from "../ports/orca.ts";
import {
  metaProcess,
  type MetaSeat,
  type MetaSeatRequest,
  type MetaSeatResult,
} from "./meta-digest.ts";

const pollMs = 30_000;

const endedStates = ["succeeded", "failed", "stopped"];

export interface MetaSeatDeps {
  db: Db;
  orca: OrcaPort;
  log: ReceiptLog;
  host: string;
  home: string;
  now: () => Date;
  pause: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const realPause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const SeatRevisions = z.object({
  crew: z.string(),
  process: z.string(),
  policy: z.string(),
});
export type SeatRevisions = z.infer<typeof SeatRevisions>;

const Stored = z.looseObject({
  request: z.looseObject({ host: z.string(), launch: z.literal(true) }),
  launch: LaunchArgs,
  spec: z.string(),
  folder: z.string(),
  revisions: SeatRevisions,
  result: z
    .looseObject({ dispatch_id: z.string(), worker_run: z.string().nullable() })
    .optional(),
  outcome: z.string().optional(),
  requestId: z.string().nullish(),
});
type Stored = z.infer<typeof Stored>;

const WorkerRun = z.looseObject({ runId: z.string().min(1) });
const LaunchedRevisions = z.looseObject({ revisions: SeatRevisions });

export function seatOpKey(stepOpKey: string, attempt: number): string {
  return derivedOpKey("tick", {
    meta_seat: stepOpKey,
    attempt: String(attempt),
  });
}

function observedKey(opKey: string): string {
  return derivedOpKey("tick", { meta_seat_observed: opKey });
}

/**
 * An operation is never moved out of done, so the mark that an attempt
 * settled without its FILE was observed is a sibling operation, done at
 * insert, with no request: openLaunches never counts it as a held slot.
 */
async function markObserved(tx: Repo, opKey: string, at: Date) {
  const key = observedKey(opKey);
  const { created } = await tx.insertOperation({
    op_key: key,
    intent: "tick",
    owner_generation: 0,
    at,
    result_ref: { observed: opKey },
  });
  if (created) await tx.moveOperation(key, "done", { observed: opKey }, at);
}

export async function seatObserved(
  db: Repo,
  stepOpKey: string,
  attempt: number,
): Promise<boolean> {
  const key = observedKey(seatOpKey(stepOpKey, attempt));
  return (await db.getOperation(key)) !== null;
}

function seatFolder(home: string, opKey: string): string {
  return join(home, "meta", sha256Hex(opKey).slice(0, 16));
}

export function seatFile(home: string, opKey: string): string {
  return join(seatFolder(home, opKey), "proposals.yaml");
}

function fail(message: string): MetaSeatResult {
  return { ok: false, message };
}

function refused(refusal: Refusal): MetaSeatResult {
  return fail(`${refusal.code}: ${refusal.message}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the Revision ids of the newest attempt under a step's op key that
 * recorded a Dispatch, from that Dispatch's requested launch.
 */
export async function seatRevisions(
  db: Repo,
  stepOpKey: string,
): Promise<SeatRevisions | null> {
  let found: SeatRevisions | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const operation = await db.getOperation(seatOpKey(stepOpKey, attempt));
    if (operation === null) return found;
    const id = Stored.safeParse(operation.result_ref).data?.result?.dispatch_id;
    const dispatch = id === undefined ? null : await db.getDispatch(id);
    const revisions = LaunchedRevisions.safeParse(dispatch?.requested_launch)
      .data?.revisions;
    if (revisions !== undefined) found = revisions;
  }
}

interface Launch {
  seat: Seat;
  launch: LaunchArgs;
  revisions: SeatRevisions;
}

async function readLaunch(
  db: Db,
  home: string,
  role: string,
): Promise<Launch | MetaSeatResult> {
  const crew = await singleActive(db, "crew", "global", "");
  if (crew === null)
    return fail("config_missing: no single active global crew Revision");
  let seats: Seat[];
  try {
    seats = readSeats(crew.value);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    return fail(`config_missing: ${error.message}`);
  }
  const seat = seats.find((each) => each.roles.includes(role));
  if (seat === undefined)
    return fail(
      `role_unfilled: no Seat in crew Revision ${crew.id} fills role ${role}`,
    );
  const process = await metaProcess(db);
  if ("result" in process)
    return fail(`config_missing: ${JSON.stringify(process.detail)}`);
  const policy = await singleActive(db, "policy", "global", "");
  if (policy === null)
    return fail("config_missing: no single active global policy Revision");
  return {
    seat,
    launch: seatLaunch(seat, `path:${join(home, "meta")}`),
    revisions: {
      crew: crew.id,
      process: process.revisionId,
      policy: policy.id,
    },
  };
}

function renderSpec(
  request: MetaSeatRequest,
  folder: string,
  hasMethod: boolean,
): string {
  return [
    `You are the ${request.role} Seat for the ${request.step} step, scope ${request.scope}.`,
    hasMethod
      ? `Follow the method in ${join(folder, "method.md")}.`
      : "No method is set for this step.",
    `Read the packet in ${join(folder, "packet.md")}.`,
    "For each learning you record, run `pod learning add --reporter digest` from this terminal.",
    `Write your proposals as a YAML list to ${join(folder, "proposals.yaml")}. Each item has theme, text, learning_ids (the learning ids it draws on, at least one), and evidence_refs.`,
    "Write that file last, then end your turn.",
  ].join("\n");
}

async function settle(
  tx: Repo,
  deps: MetaSeatDeps,
  dispatch: Dispatch,
  input: {
    settlement: "done" | "stopped";
    payload: Json;
    observed: string | null;
  },
): Promise<void> {
  const at = deps.now();
  const moved = await tx.settleDispatch(dispatch.dispatch_id, {
    activity: "settled",
    settlement: input.settlement,
    settled_at: at,
    at,
  });
  if (moved)
    await tx.appendEvent({
      type: "stop",
      ts: at,
      host: deps.host,
      run_id: null,
      task_id: null,
      dispatch_id: dispatch.dispatch_id,
      op_key: null,
      payload: input.payload,
      source: { kind: "command", verb: "tick" },
    });
  if (input.observed !== null) await markObserved(tx, input.observed, at);
}

interface SeatContext {
  deps: MetaSeatDeps;
  request: MetaSeatRequest;
}

function receiptContext(key: string) {
  return { run_id: null, task_id: null, op_key: key };
}

function fileOf(stored: Stored): string {
  return join(stored.folder, "proposals.yaml");
}

async function runSeat(ctx: SeatContext): Promise<MetaSeatResult> {
  if (ctx.request.signal.aborted)
    return fail("the step passed limits.packet_minutes before the launch");
  for (let attempt = 1; ; attempt += 1) {
    const key = seatOpKey(ctx.request.opKey, attempt);
    const operation = await ctx.deps.db.getOperation(key);
    if (operation === null) return launch(ctx, key);
    const parsed = Stored.safeParse(operation.result_ref);
    if (!parsed.success) return fail(`launch ${key} has an unreadable record`);
    const stored = parsed.data;
    if (operation.status === "pending")
      return fail(
        `launch ${key} is pending and holds a slot; it was cut off between its start and its record`,
      );
    if (operation.status === "unknown") return recover(ctx, key, stored);
    if (stored.result === undefined) continue;
    const resumed = await resume(ctx, key, stored, stored.result);
    if (resumed !== null) return resumed;
  }
}

async function resume(
  ctx: SeatContext,
  key: string,
  stored: Stored,
  result: NonNullable<Stored["result"]>,
): Promise<MetaSeatResult | null> {
  const { db } = ctx.deps;
  const dispatch = await db.getDispatch(result.dispatch_id);
  if (dispatch === null)
    return fail(
      `launch ${key} names Dispatch ${result.dispatch_id}, which is not recorded`,
    );
  if (dispatch.settlement === "open") {
    if (result.worker_run === null)
      return fail(
        `Dispatch ${dispatch.dispatch_id} is open with no worker Run`,
      );
    return wait(ctx, key, stored, dispatch, result.worker_run);
  }
  const file = fileOf(stored);
  if (existsSync(file)) return { ok: true, file };
  if ((await db.getOperation(observedKey(key))) !== null) return null;
  await db.transaction((tx) => markObserved(tx, key, ctx.deps.now()));
  return fail(
    `the Seat of Dispatch ${dispatch.dispatch_id} ended without its FILE`,
  );
}

async function launch(ctx: SeatContext, key: string): Promise<MetaSeatResult> {
  const { db, host, home } = ctx.deps;
  const read = await readLaunch(db, home, ctx.request.role);
  if ("ok" in read) return read;
  const folder = seatFolder(home, key);
  const hasMethod = ctx.request.method !== null;
  const stored: Stored = {
    request: {
      host,
      launch: true,
      step: ctx.request.step,
      scope: ctx.request.scope,
      role: ctx.request.role,
      seat: read.seat.id,
    },
    launch: read.launch,
    spec: renderSpec(ctx.request, folder, hasMethod),
    folder,
    revisions: read.revisions,
  };
  const capacity = await hostCapacity(db, host, ctx.deps.now());
  const gate = await db.transaction(async (tx) => {
    await tx.lockQuota(host);
    if ((await tx.getOperation(key)) !== null)
      return fail(`launch ${key} was started by another tick`);
    const refusal = await slotRefusal(
      tx,
      host,
      capacity,
      await openLaunches(tx),
    );
    if (refusal !== null) return refused(refusal);
    await tx.insertOperation({
      op_key: key,
      intent: "tick",
      owner_generation: 0,
      at: ctx.deps.now(),
      result_ref: Json.parse(stored),
    });
    return null;
  });
  if (gate !== null) return gate;
  let receipt: Receipt<WorkerStartResult>;
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "packet.md"), ctx.request.packet);
    if (ctx.request.method !== null)
      writeFileSync(join(folder, "method.md"), ctx.request.method);
    writeFileSync(join(folder, "spec.md"), stored.spec);
    ctx.deps.log.at(receiptContext(key));
    receipt = await ctx.deps.orca.workerStart({
      spec: stored.spec,
      ...stored.launch,
    });
  } catch (error) {
    await db.moveOperation(
      key,
      "done",
      Json.parse({ ...stored, outcome: "failed", error: messageOf(error) }),
      ctx.deps.now(),
    );
    return fail(`the launch of ${key} failed: ${messageOf(error)}`);
  }
  return record(ctx, key, stored, receipt);
}

async function recover(
  ctx: SeatContext,
  key: string,
  stored: Stored,
): Promise<MetaSeatResult> {
  const held = `launch ${key} is unknown and holds a slot`;
  if (stored.requestId == null)
    return fail(`${held}; no request id was recorded`);
  ctx.deps.log.at(receiptContext(key));
  const shown = await ctx.deps.orca.requestShow({
    request: stored.requestId,
  });
  if (shown.result?.state !== "completed")
    return fail(
      `${held}; request-show ${shown.result?.state ?? "gave no answer"}`,
    );
  ctx.deps.log.at(receiptContext(key));
  const receipt = await ctx.deps.orca.workerStart({
    spec: stored.spec,
    ...stored.launch,
    retryRequest: stored.requestId,
  });
  return record(ctx, key, stored, receipt);
}

async function record(
  ctx: SeatContext,
  key: string,
  stored: Stored,
  receipt: Receipt<WorkerStartResult>,
): Promise<MetaSeatResult> {
  const { db } = ctx.deps;
  const outcome = launchOutcome(receipt);
  const launched =
    outcome.kind === "ok" && receipt.result !== null
      ? fromReceipt(receipt.result)
      : null;
  if (launched === null) {
    const unknown = outcome.kind === "unknown";
    await db.moveOperation(
      key,
      unknown ? "unknown" : "done",
      Json.parse(
        unknown
          ? { ...stored, requestId: outcome.requestId }
          : { ...stored, outcome: "failed", raw: receipt.raw ?? null },
      ),
      ctx.deps.now(),
    );
    return fail(
      unknown
        ? `worker-start of ${key} has no known outcome; the launch holds a slot`
        : `worker-start of ${key} failed: ${errorCode(receipt.raw)}`,
    );
  }
  const workerRun = WorkerRun.safeParse(receipt.result).data?.runId ?? null;
  if (workerRun === null) return noWorkerRun(ctx, key, stored, launched);
  const done: Stored = {
    ...stored,
    result: { dispatch_id: launched.dispatchId, worker_run: workerRun },
  };
  const dispatch = await db.transaction(async (tx) => {
    await tx.lockQuota(stored.request.host);
    await tx.moveOperation(key, "done", Json.parse(done), ctx.deps.now());
    await insert(ctx, tx, key, stored, launched, workerRun);
    return tx.getDispatch(launched.dispatchId);
  });
  if (dispatch === null)
    return fail(`Dispatch ${launched.dispatchId} did not read back`);
  return wait(ctx, key, done, dispatch, workerRun);
}

async function insert(
  ctx: SeatContext,
  tx: Repo,
  key: string,
  stored: Stored,
  launched: Launched,
  workerRun: string | null,
): Promise<void> {
  await insertStart(tx, {
    owner: { task_id: null, decision_id: null },
    run_id: null,
    role: ctx.request.role,
    seat: String(stored.request["seat"]),
    host: stored.request.host,
    launched,
    requested_launch: Json.parse({
      ...(requestedLaunch(launched, stored.launch) as Record<string, Json>),
      revisions: stored.revisions,
      folder: stored.folder,
      worker_run: workerRun,
    }),
    model_attribution: attribution(launched),
    retry_of: null,
    op_key: key,
    manifest_id: null,
    prompt_bytes: Buffer.byteLength(stored.spec),
    verb: "tick",
    late: false,
    at: ctx.deps.now(),
    revisions: stored.revisions,
  });
}

async function noWorkerRun(
  ctx: SeatContext,
  key: string,
  stored: Stored,
  launched: Launched,
): Promise<MetaSeatResult> {
  const { db } = ctx.deps;
  ctx.deps.log.at(receiptContext(key));
  const stop = await ctx.deps.orca.workerStop({
    dispatch: launched.dispatchId,
  });
  const confirmed = stop.exitCode === 0 && stop.result !== null;
  const done: Stored = {
    ...stored,
    result: { dispatch_id: launched.dispatchId, worker_run: null },
  };
  await db.transaction(async (tx) => {
    await tx.lockQuota(stored.request.host);
    await tx.moveOperation(key, "done", Json.parse(done), ctx.deps.now());
    await insert(ctx, tx, key, stored, launched, null);
    const dispatch = await tx.getDispatch(launched.dispatchId);
    if (dispatch === null)
      throw new Error(`Dispatch ${launched.dispatchId} did not read back`);
    await settle(tx, ctx.deps, dispatch, {
      settlement: "stopped",
      payload: {
        reason: "no_worker_run",
        stop: confirmed ? "stopped" : errorCode(stop.raw),
      },
      observed: key,
    });
  });
  return fail(
    confirmed
      ? `worker-start of ${key} named no worker Run; Dispatch ${launched.dispatchId} was stopped`
      : `worker-start of ${key} named no worker Run, and worker-stop was not confirmed; run orca orchestration worker-stop --dispatch ${launched.dispatchId}`,
  );
}

async function wait(
  ctx: SeatContext,
  key: string,
  stored: Stored,
  dispatch: Dispatch,
  workerRun: string,
): Promise<MetaSeatResult> {
  const { db, orca, log } = ctx.deps;
  const file = fileOf(stored);
  const id = dispatch.dispatch_id;
  for (;;) {
    if (ctx.request.signal.aborted) return abort(ctx, key, stored, dispatch);
    log.at(receiptContext(key));
    const row = (await listWorkers(orca, workerRun))?.find(
      (each) => each.dispatchId === id,
    );
    const written = existsSync(file);
    if (
      row !== undefined &&
      (endedStates.includes(row.workerState) ||
        (written && row.workerState === "ready"))
    ) {
      if (!endedStates.includes(row.workerState)) {
        log.at(receiptContext(key));
        await orca.workerStop({ dispatch: id });
      }
      await db.transaction((tx) =>
        settle(tx, ctx.deps, dispatch, {
          settlement: written ? "done" : "stopped",
          payload: { worker_state: row.workerState },
          observed: written ? null : key,
        }),
      );
      return written
        ? { ok: true, file }
        : fail(
            `the Seat of Dispatch ${id} ended ${row.workerState} without its FILE`,
          );
    }
    await ctx.deps.pause(pollMs, ctx.request.signal);
  }
}

async function abort(
  ctx: SeatContext,
  key: string,
  stored: Stored,
  dispatch: Dispatch,
): Promise<MetaSeatResult> {
  const id = dispatch.dispatch_id;
  ctx.deps.log.at(receiptContext(key));
  const stop = await ctx.deps.orca.workerStop({ dispatch: id });
  if (stop.exitCode !== 0 || stop.result === null)
    return fail(
      `the step passed limits.packet_minutes; worker-stop of Dispatch ${id} failed (${errorCode(stop.raw)}) and the Dispatch stays open`,
    );
  await ctx.deps.db.transaction((tx) =>
    settle(tx, ctx.deps, dispatch, {
      settlement: "stopped",
      payload: { reason: "packet_minutes" },
      observed: key,
    }),
  );
  return fail(
    `the step passed limits.packet_minutes; Dispatch ${id} was stopped`,
  );
}

export function metaSeat(deps: MetaSeatDeps): MetaSeat {
  return {
    built: true,
    run: (request) => runSeat({ deps, request }),
  };
}
