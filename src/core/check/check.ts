import { z } from "zod";
import { singleActive } from "../config/active.ts";
import { activateRequested, pendingActivations } from "../config/apply.ts";
import { decisionLimits } from "../config/limits.ts";
import { advanceDecision, chargeBudget } from "../decide/advance.ts";
import { applyRuling } from "../decide/ruling.ts";
import { followDecisions } from "../decide/sends.ts";
import { followSupersedes } from "../decide/supersede.ts";
import { Templates } from "../decide/templates.ts";
import {
  deliveryFacts,
  deliveryOutcome,
  planFields,
  readDecisionMessage,
  type DecisionMessage,
  type DeliveryRow,
} from "../domain/delivery.ts";
import { openStates } from "../domain/decision.ts";
import { HoldPayload, latestDispatch, resumeTarget } from "../domain/hold.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch, Run, Task } from "../domain/ledger.ts";
import { refuse, type Checked, type Refused } from "../domain/outcome.ts";
import { hostFreeSlots, openLaunches } from "../dispatch/quota.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import { moveTask } from "../ledger/move-task.ts";
import { recordDeliveryTests } from "../manifest/record.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaMessage, OrcaPort, WorkerRow } from "../ports/orca.ts";
import { followReworks } from "../process/follow-rework.ts";
import { recordDelivery } from "../process/project.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import { drainOutbox } from "../tracker/outbox.ts";
import { syncStory } from "../tracker/sync.ts";
import { voidEditedReceipts } from "../gate/hqa.ts";
import {
  readStoryComments,
  verifiedActivations,
  verifiedRulings,
  waitingDecisions,
} from "../gate/ruling.ts";
import { syncVerdictReceipts } from "../gate/verdict.ts";
import { fence, StaleGeneration } from "./fence.ts";
import {
  followUpParent,
  messageFollowUp,
  stopFollowUps,
  type FollowUp,
} from "./follow-up.ts";
import { reconcileLaunches, type Reconciled } from "./reconcile.ts";
import { reconcileTakeovers } from "./takeover-reconcile.ts";
import { recordNoSource } from "./usage.ts";
import { memoWorkers } from "./workers.ts";

export interface CheckInput {
  run: string;
  generation: number;
  host: string;
  capacity: number;
  now: () => Date;
  leaseSeconds: number;
  hostName?: string;
  bypassPath?: string;
}

export interface CheckResult {
  run_id: string;
  reconciled: Reconciled[];
  deliveries: { message_id: string; dispatch_id: string; outcome: string }[];
  ignored: number;
  acked: string[];
  stopped: string[];
  unknown_workers: string[];
  free_slots: number;
  nextSteps: string[];
}

const openTaskStates = ["ready", "dispatched", "delivered"];
const nextKeyCodes = ["quota_exhausted", "drained"];

function stale(run: Run, generation: number): Refused {
  return refuse(
    "owner_generation_stale",
    `--generation ${generation} differs from the Run's owner generation ${run.owner_generation}`,
    [
      `pod takeover story:${run.story_external_id} if this session should own the Run`,
    ],
  );
}

async function ownedRun(
  repo: Repo,
  runId: string,
  generation: number,
): Promise<{ run: Run } | Refused> {
  const run = await repo.getRun(runId);
  if (run === null)
    return refuse("task_not_ready", `no Run ${runId}`, ["pod brief"]);
  if (run.owner_generation !== generation) return stale(run, generation);
  return { run };
}

export async function checkPass(
  db: Db,
  orca: OrcaPort,
  tracker: TrackerPort | null,
  log: ReceiptLog,
  input: CheckInput,
): Promise<Checked<CheckResult>> {
  const owned = await ownedRun(db, input.run, input.generation);
  if ("ok" in owned) return owned;
  const { run } = owned;
  const { version } = await orca.version();
  const workers = memoWorkers(orca, run.run_id);
  const result: CheckResult = {
    run_id: run.run_id,
    reconciled: [],
    deliveries: [],
    ignored: 0,
    acked: [],
    stopped: [],
    unknown_workers: [],
    free_slots: 0,
    nextSteps: [],
  };
  const tracked: string[] = [];
  try {
    if (tracker !== null) {
      const synced = await syncStory(db, tracker, log, {
        run,
        generation: input.generation,
        host: input.host,
        now: input.now,
      });
      if (synced.error !== null)
        tracked.push(
          `tracker read of story:${run.story_external_id} failed: ${synced.error}; run pod check again`,
        );
      if (synced.canceled)
        tracked.push(
          `story:${run.story_external_id} is ${synced.status ?? "Canceled"} in the tracker; the Run is on hold`,
        );
    }
    const takeover = await reconcileTakeovers(db, orca, log, {
      run,
      generation: input.generation,
      host: input.host,
      now: input.now,
    });
    if (takeover !== null)
      return {
        ok: true,
        result: {
          ...result,
          nextSteps: [
            ...tracked,
            ...takeover,
            ...(await recordNoSource(db, run, input.now())),
          ],
        },
        orca: version,
      };
    const launches = await reconcileLaunches(db, orca, log, {
      run,
      generation: input.generation,
      workers,
      now: input.now,
      leaseSeconds: input.leaseSeconds,
    });
    result.reconciled = launches.reconciled;
    await chargeOpenDecisions(db, run, input);
    result.nextSteps = [
      ...launches.reconciled
        .filter((row) => row.to === "unknown")
        .map((row) => `pod check: launch ${row.op_key} is still unknown`),
      ...launches.nextSteps,
    ];
    if (tracker !== null) {
      const drained = await drainOutbox(db, tracker, log, {
        run_id: run.run_id,
        generation: input.generation,
        host: input.host,
        now: input.now,
      });
      const parked = await db.listOutboxParked();
      const parkedIds = new Set(parked.map((row) => row.id));
      for (const failed of drained.failed)
        if (!parkedIds.has(failed.id))
          tracked.push(
            `tracker outbox row ${failed.id} failed: ${failed.error}; run pod check again`,
          );
      for (const row of parked)
        tracked.push(
          `tracker outbox row ${row.id} parked after ${row.tries} tries: ${row.last_error ?? "no error recorded"}; fix the cause, then reset its tries`,
        );
      await syncVerdictReceipts(db, run.run_id);
      const voids = await voidEditedReceipts(db, tracker, log, {
        run: run.run_id,
        generation: input.generation,
        host: input.host,
        now: input.now,
      });
      tracked.push(...voids.nextSteps);
      tracked.push(...(await applyRulings(db, tracker, log, run, input)));
    }
    result.nextSteps.unshift(...tracked);
    const read = await readDeliveries(db, orca, log, input, result);
    if (read !== null) return read;
    result.nextSteps.push(
      ...(await followDecisions(db, orca, log, {
        run,
        templates: await activeTemplates(db),
        generation: input.generation,
        host: input.host,
        capacity: input.capacity,
        now: input.now,
      })),
    );
    result.nextSteps.push(
      ...(await followSupersedes(db, orca, log, {
        run,
        workers,
        host: input.host,
        now: input.now,
      })),
    );
    result.nextSteps.push(
      ...(await followReworks(db, orca, log, {
        run,
        host: input.host,
        now: input.now,
      })),
    );
    const rows = await workers();
    if (rows === null)
      result.nextSteps.push("worker-list unreadable; run pod check again");
    else {
      const recorded = await recordWorkers(db, run, rows, input);
      result.stopped = recorded.stopped;
      result.unknown_workers = recorded.unknown;
      result.nextSteps.push(
        ...(await stopFollowUps(db, orca, log, {
          run,
          generation: input.generation,
          host: input.host,
          now: input.now,
          followUps: recorded.followUps,
        })),
      );
    }
  } catch (error) {
    if (error instanceof StaleGeneration)
      return stale(error.run, input.generation);
    throw error;
  }

  result.free_slots = await hostFreeSlots(db, input.host, input.capacity);
  if (result.free_slots >= 1)
    result.nextSteps.push(...(await nextKeys(db, run, input.generation)));
  result.nextSteps.push(...(await recordNoSource(db, run, input.now())));
  return { ok: true, result, orca: version };
}

async function chargeOpenDecisions(
  db: Db,
  run: Run,
  input: CheckInput,
): Promise<void> {
  for (const decision of await db.openDecisionsForRun(run.run_id))
    await db.transaction(async (tx) => {
      await fence(tx, run.run_id, input.generation);
      await chargeBudget(tx, decision.id, {
        at: input.now(),
        host: input.host,
      });
    });
}

async function applyRulings(
  db: Db,
  tracker: TrackerPort,
  log: ReceiptLog,
  run: Run,
  input: CheckInput,
): Promise<string[]> {
  const pending = await pendingActivations(db);
  const waiting = await waitingDecisions(db, run.run_id);
  if (waiting.size === 0 && pending.length === 0) return [];
  const needsStory =
    waiting.size > 0 || pending.some((row) => row.request.ticket === null);
  const read = needsStory
    ? await readStoryComments(tracker, log, run)
    : { ok: true as const, comments: [] };
  if (!read.ok)
    return [
      `tracker readback of story:${run.story_external_id} failed: ${read.error}; Decision rulings and profile requests wait for the next pod check`,
    ];
  const context = {
    run,
    hostName: input.hostName,
    bypassPath: input.bypassPath,
    now: input.now,
  };
  const { rulings, nextSteps } = await verifiedRulings(
    db,
    tracker,
    read.comments,
    context,
  );
  for (const ruling of rulings) {
    const step = await db.transaction(async (tx) => {
      const owned = await fence(tx, run.run_id, input.generation);
      return applyRuling(tx, owned, ruling, {
        at: input.now(),
        host: input.host,
      });
    });
    if (step !== null) nextSteps.push(step);
  }
  const activations = await verifiedActivations(db, tracker, pending, {
    ...context,
    log,
    storyComments: read.comments,
  });
  nextSteps.push(...activations.nextSteps);
  for (const readback of activations.readbacks) {
    const step = await db.transaction(async (tx) => {
      await fence(tx, run.run_id, input.generation);
      return activateRequested(tx, readback.revision_id, readback.source, {
        at: input.now(),
        host: input.host,
        activatedBy: readback.activated_by,
      });
    });
    if (step !== null) nextSteps.push(step);
  }
  return nextSteps;
}

async function readDeliveries(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: CheckInput,
  result: CheckResult,
): Promise<Refused | null> {
  log.at({ run_id: input.run, task_id: null, op_key: null });
  let batch = await orca.check({ run: input.run });
  for (;;) {
    if (batch.exitCode !== 0 || batch.result === null)
      return refuse("failed", `check --run ${input.run} failed`, [
        errorCode(batch.raw),
        "run pod check again from the Run's coordinator terminal",
      ]);
    const { deliveryId, messages } = batch.result;
    if (messages.length === 0 || deliveryId === null) return null;
    await db.transaction(async (tx) => {
      const run = await fence(tx, input.run, input.generation);
      for (const message of messages)
        await recordMessage(tx, run, deliveryId, message, input, result);
    });
    result.acked.push(deliveryId);
    batch = await orca.check({ run: input.run, ack: deliveryId });
  }
}

const ErrorEnvelope = z.looseObject({
  error: z.looseObject({ code: z.string() }),
});

function errorCode(raw: unknown): string {
  const parsed = ErrorEnvelope.safeParse(raw);
  return parsed.success
    ? `Orca error ${parsed.data.error.code}`
    : "Orca gave no readable reply";
}

async function matchOf(tx: Repo, run: Run, dispatch: Dispatch | null) {
  if (dispatch === null || dispatch.run_id !== run.run_id) return null;
  if (dispatch.task_id === null)
    return { settlement: dispatch.settlement, latest: true };
  const siblings = (await tx.listDispatches(run.run_id)).filter(
    (row) => row.task_id === dispatch.task_id,
  );
  return {
    settlement: dispatch.settlement,
    latest: siblings.every(
      (row) => row.created_at.getTime() <= dispatch.created_at.getTime(),
    ),
  };
}

async function recordMessage(
  tx: Repo,
  run: Run,
  deliveryId: string,
  message: OrcaMessage,
  input: CheckInput,
  result: CheckResult,
): Promise<void> {
  if (await tx.messageRecorded(run.run_id, message.id)) return;
  const id = message.payload.dispatchId;
  const dispatch = id === undefined ? null : await tx.getDispatch(id);
  const known = dispatch?.run_id === run.run_id ? dispatch : null;
  const row: DeliveryRow = deliveryOutcome(
    message,
    await matchOf(tx, run, known),
  );
  if (row.kind === "none") return;
  const at = input.now();
  const base = {
    ts: at,
    host: input.host,
    run_id: run.run_id,
    task_id: known?.task_id ?? null,
    dispatch_id: known?.dispatch_id ?? null,
    op_key: null,
    source: { kind: "command", verb: "check" },
  };
  const said = {
    message_id: message.id,
    delivery_id: deliveryId,
    type: message.type,
  };
  const ignore = async (reason: string, extra: Record<string, Json> = {}) => {
    await tx.appendEvent({
      ...base,
      type: "ignored",
      payload: { ...said, reason, ...extra },
    });
    result.ignored += 1;
  };
  if (known === null && row.kind === "ignored") {
    const parent = await messageFollowUp(tx, run, message);
    if (parent !== null) return ignore("follow_up", { follow_up_of: parent });
  }
  if (row.kind === "ignored") return ignore(row.reason);
  if (known === null) return;
  let decision: Record<string, Json> = {};
  if (known.task_id === null) {
    const read = readDecisionMessage(message);
    if (read.kind === "malformed") {
      result.nextSteps.push(`ignored ${read.detail}`);
      return ignore("malformed_decision");
    }
    if (read.kind === "message") {
      const advanced = await advanceDecision(tx, {
        run,
        dispatch: known,
        message: read.message,
        bound: await roundBound(tx, run),
        at,
        host: input.host,
      });
      if (advanced.kind === "ignored") {
        if (advanced.detail !== undefined)
          result.nextSteps.push(`ignored ${advanced.detail}`);
        return ignore(advanced.reason);
      }
      if (
        read.message.kind === "decision_proposal" &&
        read.message.plan === undefined &&
        (await tx.getDecision(read.message.decisionId))?.effect ===
          "accept_plan"
      )
        result.nextSteps.push(
          `Decision ${read.message.decisionId} round ${read.message.round}: proposal names no plan field; read it before pod dispatch`,
        );
      decision = {
        decision_id: read.message.decisionId,
        round: String(read.message.round),
        kind: read.message.kind,
        ...decisionFields(read.message),
      };
    }
  }
  await tx.appendEvent({
    ...base,
    type: "delivery",
    payload: Json.parse({
      ...said,
      outcome: row.outcome,
      subject: message.subject ?? null,
      ...decision,
    }),
  });
  result.deliveries.push({
    message_id: message.id,
    dispatch_id: known.dispatch_id,
    outcome: row.outcome,
  });
  if (message.type === "worker_done") {
    const { facts, ignored } = deliveryFacts(message);
    result.nextSteps.push(...ignored);
    result.nextSteps.push(
      ...(await recordDeliveryTests(tx, known.manifest_id, message)),
    );
    for (const fact of facts)
      await tx.appendEvent({
        ...base,
        type: fact.type,
        payload: {
          task_id: known.task_id,
          dispatch_id: known.dispatch_id,
          ...fact.fields,
        },
      });
  }
  if (known.task_id === null) {
    if (row.outcome !== "unknown")
      await tx.settleDispatch(known.dispatch_id, {
        activity: row.activity,
        settlement: row.settlement,
        settled_at: row.settlement === "open" ? null : at,
      });
    return;
  }
  const task = await tx.getTask(known.task_id);
  if (task === null) return;
  if (row.outcome === "unknown") {
    if (task.state !== "dispatched") return;
    await moveTask(tx, task.task_id, "hold");
    await tx.appendEvent({
      ...base,
      type: "hold",
      payload: {
        reason: "unknown_delivery",
        message_id: message.id,
        from: task.state,
      },
    });
    return;
  }
  const moved = await tx.settleDispatch(known.dispatch_id, {
    activity: row.activity,
    settlement: row.settlement,
    settled_at: row.settlement === "open" ? null : at,
  });
  if (moved && task.state === "dispatched")
    await moveTask(tx, task.task_id, "delivered");
  if (moved && row.settlement !== "open")
    await recordDelivery(tx, {
      task: task.task_id,
      settlement: row.settlement,
      at,
      host: input.host,
      source: base.source,
    });
}

function decisionFields(message: DecisionMessage): Record<string, Json> {
  switch (message.kind) {
    case "decision_proposal":
      return {
        proposal: message.proposal,
        citations: message.citations,
        ...planFields(message),
      };
    case "decision_audit":
      return { stance: message.stance };
    case "decision_evidence":
      return { references: message.references.length };
  }
}

async function roundBound(tx: Repo, run: Run): Promise<number> {
  const snapshot = await tx.getSnapshot(run.run_id);
  const policy =
    snapshot === null
      ? null
      : await tx.getRevision(snapshot.policy_revision_id);
  return decisionLimits(policy?.value).decision_rounds;
}

async function activeTemplates(db: Db): Promise<Templates | null> {
  const revision = await singleActive(db, "decision", "global", "");
  return Templates.safeParse(revision?.value).data ?? null;
}

async function recordWorkers(
  db: Db,
  run: Run,
  rows: readonly WorkerRow[],
  input: CheckInput,
): Promise<{ stopped: string[]; unknown: string[]; followUps: FollowUp[] }> {
  return db.transaction(async (tx) => {
    await fence(tx, run.run_id, input.generation);
    return {
      stopped: await recordStops(tx, run, rows, input),
      ...(await recordUnknownWorkers(tx, run, rows, input)),
    };
  });
}

async function recordStops(
  tx: Repo,
  run: Run,
  rows: readonly WorkerRow[],
  input: CheckInput,
): Promise<string[]> {
  const stopped: string[] = [];
  for (const row of rows) {
    if (row.workerState !== "stopped") continue;
    const dispatch = await tx.getDispatch(row.dispatchId);
    if (dispatch?.run_id !== run.run_id || dispatch.settlement !== "open")
      continue;
    const at = input.now();
    await tx.settleDispatch(dispatch.dispatch_id, {
      activity: "settled",
      settlement: "stopped",
      settled_at: at,
    });
    await tx.appendEvent({
      type: "stop",
      ts: at,
      host: input.host,
      run_id: run.run_id,
      task_id: dispatch.task_id,
      dispatch_id: dispatch.dispatch_id,
      op_key: null,
      payload: { worker_state: row.workerState },
      source: { kind: "command", verb: "check" },
    });
    const task =
      dispatch.task_id === null ? null : await tx.getTask(dispatch.task_id);
    if (task?.state === "dispatched")
      await moveTask(tx, task.task_id, "blocked");
    stopped.push(dispatch.dispatch_id);
  }
  return stopped;
}

async function recordUnknownWorkers(
  tx: Repo,
  run: Run,
  rows: readonly WorkerRow[],
  input: CheckInput,
): Promise<{ unknown: string[]; followUps: FollowUp[] }> {
  const dispatches = await tx.listDispatches(run.run_id);
  const known = new Set(dispatches.map((row) => row.dispatch_id));
  const inFlight = new Set(
    (await openLaunches(tx)).map((row) => row.request?.task_id),
  );
  const at = input.now();
  const found: string[] = [];
  const followUps: FollowUp[] = [];
  for (const row of rows) {
    if (known.has(row.dispatchId)) continue;
    if (row.taskId != null && inFlight.has(row.taskId)) continue;
    const parent = followUpParent(row, dispatches);
    if (parent !== null)
      followUps.push({
        dispatchId: row.dispatchId,
        parent,
        workerState: row.workerState,
      });
    if ((await tx.dispatchEvent(row.dispatchId, "unknown_launch")) !== null)
      continue;
    await tx.appendEvent({
      type: "unknown_launch",
      ts: at,
      host: input.host,
      run_id: run.run_id,
      task_id: null,
      dispatch_id: row.dispatchId,
      op_key: null,
      payload: Json.parse({
        worker_task_id: row.taskId ?? null,
        worker_state: row.workerState,
        ...(parent === null ? {} : { follow_up_of: parent }),
      }),
      source: { kind: "command", verb: "check" },
    });
    if (parent === null) found.push(row.dispatchId);
  }
  const current = await tx.getRun(run.run_id);
  if (
    found.length === 0 ||
    (current?.state !== "active" && current?.state !== "drained")
  )
    return { unknown: found, followUps };
  const hold = (task_id: string | null, from: string) =>
    tx.appendEvent({
      type: "hold",
      ts: at,
      host: input.host,
      run_id: run.run_id,
      task_id,
      dispatch_id: null,
      op_key: null,
      payload: { reason: "unknown_launch", dispatch_ids: found, from },
      source: { kind: "command", verb: "check" },
    });
  await tx.setRunState(run.run_id, "hold");
  await hold(null, current.state);
  for (const task of await tx.listTasks(run.run_id)) {
    if (!openTaskStates.includes(task.state)) continue;
    await moveTask(tx, task.task_id, "hold");
    await hold(task.task_id, task.state);
  }
  return { unknown: found, followUps };
}

const Refusal = z.looseObject({
  request: z.looseObject({ task_id: z.string(), seat: z.string() }),
  code: z.string(),
});

async function nextKeys(
  db: Db,
  run: Run,
  generation: number,
): Promise<string[]> {
  if (await drainInForce(db, run.run_id)) return [];
  const tasks = await db.listTasks(run.run_id);
  const ready = new Set(
    tasks.filter((task) => task.state === "ready").map((task) => task.task_id),
  );
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const operation of await db.listOperations(["dispatch"], ["refused"])) {
    const ref = Refusal.safeParse(operation.result_ref);
    if (!ref.success || !nextKeyCodes.includes(ref.data.code)) continue;
    const { task_id, seat } = ref.data.request;
    const pair = `${task_id}\n${seat}`;
    if (!ready.has(task_id) || seen.has(pair)) continue;
    seen.add(pair);
    let attempt = 1;
    let key = derivedOpKey("dispatch", {
      run_id: run.run_id,
      task_id,
      seat,
      attempt: "1",
    });
    while ((await db.getOperation(key)) !== null) {
      attempt += 1;
      key = derivedOpKey("dispatch", {
        run_id: run.run_id,
        task_id,
        seat,
        attempt: String(attempt),
      });
    }
    steps.push(
      `pod dispatch --task ${task_id} --seat ${seat} --generation ${generation} --op-key ${key}`,
    );
  }
  return steps;
}

export interface WaitInput extends CheckInput {
  decision: string | null;
  interval: number;
  timeout: number;
  sleep: (seconds: number) => Promise<void>;
}

export async function checkWait(
  db: Db,
  orca: OrcaPort,
  tracker: TrackerPort | null,
  log: ReceiptLog,
  input: WaitInput,
): Promise<Checked<CheckResult>> {
  const start = input.now().getTime();
  for (;;) {
    const pass = await checkPass(db, orca, tracker, log, input);
    if (!pass.ok) return pass;
    if (input.decision !== null) {
      const decision = await db.getDecision(input.decision);
      if (decision === null)
        return refuse("task_not_ready", `no Decision ${input.decision}`, [
          "pod brief",
        ]);
      if (!openStates.includes(decision.state)) return pass;
    } else if (pass.result.deliveries.length > 0 || pass.result.free_slots >= 1)
      return pass;
    const waited = Math.floor((input.now().getTime() - start) / 1000);
    if (waited >= input.timeout)
      return refuse(
        "failed",
        input.decision === null
          ? `pod check --wait waited ${waited} seconds with no delivery and no free slot`
          : `pod check --wait waited ${waited} seconds and Decision ${input.decision} is still open`,
        [
          ...pass.result.nextSteps,
          input.decision === null
            ? "pod check --wait"
            : `pod check --wait --decision ${input.decision}`,
        ],
      );
    await input.sleep(input.interval);
  }
}

export interface ResumeInput {
  run: string | null;
  task: string | null;
  generation: number;
  host: string;
  now: () => Date;
}

export interface ResumeResult {
  run_id: string;
  resumed: { kind: "run" | "task"; id: string; to: string }[];
}

type Resumed = { ok: true; result: ResumeResult } | Refused;

export async function resume(db: Db, input: ResumeInput): Promise<Resumed> {
  return db.transaction(async (tx): Promise<Resumed> => {
    const task = input.task === null ? null : await tx.getTask(input.task);
    if (input.task !== null && task === null)
      return refuse("task_not_ready", `no Task ${input.task}`, ["pod brief"]);
    const runId = task?.run_id ?? input.run ?? "";
    const owned = await ownedRun(tx, runId, input.generation);
    if ("ok" in owned) return owned;
    const { run } = owned;
    const at = input.now();
    const resumed: ResumeResult["resumed"] = [];
    const record = (task_id: string | null, to: string) =>
      tx.appendEvent({
        type: "resume",
        ts: at,
        host: input.host,
        run_id: run.run_id,
        task_id,
        dispatch_id: null,
        op_key: null,
        payload: { reason: "operator", to },
        source: { kind: "command", verb: "check --resume" },
      });
    const restore = async (held: Task) => {
      const hold = await tx.latestEvent(run.run_id, "hold", {
        taskId: held.task_id,
      });
      const payload =
        hold === null ? undefined : HoldPayload.safeParse(hold.payload).data;
      const to = resumeTarget(
        payload?.from,
        latestDispatch(await tx.listDispatches(run.run_id), held.task_id),
      );
      await moveTask(tx, held.task_id, to);
      await record(held.task_id, to);
      resumed.push({ kind: "task", id: held.task_id, to });
    };
    if (task !== null) {
      if (task.state !== "hold")
        return refuse(
          "task_not_ready",
          `Task ${task.task_id} is ${task.state}, not hold`,
          [`Task state ${task.state}`],
        );
      await restore(task);
    } else {
      if (run.state !== "hold")
        return refuse(
          "task_not_ready",
          `Run ${run.run_id} is ${run.state}, not hold`,
          [`Run state ${run.state}`],
        );
      const to = (await drainInForce(tx, run.run_id)) ? "drained" : "active";
      await tx.setRunState(run.run_id, to);
      await record(null, to);
      resumed.push({ kind: "run", id: run.run_id, to });
      for (const held of await tx.listTasks(run.run_id))
        if (held.state === "hold") await restore(held);
    }
    return { ok: true, result: { run_id: run.run_id, resumed } };
  });
}
