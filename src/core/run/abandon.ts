import { z } from "zod";
import { memoWorkers } from "../check/workers.ts";
import { workerEnded } from "../check/check.ts";
import { openStates } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch, Run, Task } from "../domain/ledger.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import { quote } from "../domain/shell.ts";
import { openLaunches } from "../dispatch/quota.ts";
import { stopDispatch } from "../dispatch/stop.ts";
import { gateOf } from "../gate/receipt.ts";
import { moveTask } from "../ledger/move-task.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, WorkerRow } from "../ports/orca.ts";
import { ProcessValue } from "../process/schema.ts";

const abandonReason = "run_abandoned";

export const finishedTasks: readonly string[] = [
  "done",
  "superseded",
  "failed",
];

export const heldDecisions: readonly string[] = [
  ...openStates,
  "needs_human",
  "reserved_needs_human",
];

export interface SettleInput {
  story: string;
  generation: number;
  host: string;
  reason: string;
  now: () => Date;
}

export interface AbandonInput extends SettleInput {
  person: boolean;
  actor: string;
  policy: unknown;
  process: unknown;
}

const Abandoned = z.looseObject({
  reason: z.literal(abandonReason),
  text: z.string(),
  actor: z.string(),
});

/** The run-wide cancel event an earlier abandon wrote, or null. */
export async function abandonRecord(
  db: Repo,
  runId: string,
): Promise<{ text: string; actor: string } | null> {
  for (const event of await db.listEvents(runId, "cancel")) {
    if (event.task_id !== null || event.dispatch_id !== null) continue;
    const parsed = Abandoned.safeParse(event.payload);
    if (parsed.success)
      return { text: parsed.data.text, actor: parsed.data.actor };
  }
  return null;
}

function abandonEnded(row: WorkerRow): boolean {
  return (
    workerEnded(row) ||
    row.workerState === "succeeded" ||
    row.workerState === "failed"
  );
}

function closeCommand(input: SettleInput): string {
  return `pod run close story:${input.story} --generation ${input.generation} --abandon ${quote(input.reason)}`;
}

function personGates(tasks: readonly Task[], input: AbandonInput): string[] {
  const parsed = ProcessValue.safeParse(input.process);
  if (!parsed.success) return ["the pinned process, which does not parse"];
  const steps = parsed.data.steps;
  return tasks.flatMap((task) => {
    if (task.state !== "ready" && task.state !== "delivered") return [];
    const step = steps.find((row) => row.id === task.step_id);
    if (step === undefined) return [];
    const person =
      step.type === "human_wait" ||
      (step.gate !== undefined &&
        gateOf(input.policy, step.gate)?.type === "HQA");
    return person
      ? [`${step.gate ?? step.id} (Task ${task.task_id}, ${task.state})`]
      : [];
  });
}

async function held(
  db: Repo,
  run: Run,
  tasks: readonly Task[],
  input: AbandonInput,
): Promise<Refused | null> {
  const decisions = (await db.listRunDecisions(run.run_id))
    .filter((row) => heldDecisions.includes(row.state))
    .map(
      (row) =>
        `Decision ${row.id} is ${row.state}: pod decide cancel ${row.id}`,
    );
  const ids = new Set(tasks.map((task) => task.task_id));
  const launches = (await openLaunches(db))
    .filter((row) => ids.has(row.request?.task_id ?? ""))
    .map((row) => `launch ${row.op_key} is ${row.status}: pod check`);
  const owed = [...decisions, ...launches];
  if (owed.length === 0) return null;
  return refuse(
    "owed_work",
    `Run ${run.run_id} cannot be abandoned while ${owed.length} item(s) are held by their own verbs`,
    [...owed, `pod state story:${input.story}`],
  );
}

async function foreignHosts(
  db: Repo,
  open: readonly Dispatch[],
  input: SettleInput,
): Promise<Refused | null> {
  const foreign: string[] = [];
  const hosts = new Set<string>();
  for (const row of open) {
    const host =
      (await db.dispatchEvent(row.dispatch_id, "start"))?.host ??
      row.owner_host;
    if (host === input.host) continue;
    foreign.push(`Dispatch ${row.dispatch_id} started on host ${host}`);
    hosts.add(host);
  }
  if (foreign.length === 0) return null;
  return refuse(
    "wrong_host",
    `${foreign.length} open Dispatch(es) started on another host, and this close runs on ${input.host}`,
    [
      ...foreign,
      ...[...hosts].map((host) => `on host ${host}: ${closeCommand(input)}`),
    ],
  );
}

async function settleStopped(
  db: Db,
  run: Run,
  row: Dispatch,
  workerState: Record<string, Json>,
  input: SettleInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const at = input.now();
    const moved = await tx.settleDispatch(row.dispatch_id, {
      activity: "settled",
      settlement: "stopped",
      settled_at: at,
      at,
    });
    if (!moved) return;
    await tx.appendEvent({
      type: "stop",
      ts: at,
      host: input.host,
      run_id: run.run_id,
      task_id: row.task_id,
      dispatch_id: row.dispatch_id,
      op_key: null,
      payload: Json.parse({ reason: abandonReason, ...workerState }),
      source: { kind: "command", verb: "run close" },
    });
  });
}

function workerFields(row: WorkerRow | undefined): Record<string, Json> {
  if (row === undefined) return { worker_state: "absent" };
  return {
    worker_state: row.workerState,
    ...(row.workerState === "abandoned"
      ? { terminal_state: row.terminalState ?? null }
      : {}),
  };
}

/** Settles each open worker Dispatch of the Run, leaving its Task where it is; a live stop that must wait refuses before an ended or absent one settles. */
export async function settleOpen(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  run: Run,
  input: SettleInput,
): Promise<string[] | Refused> {
  const open = (await db.listDispatches(run.run_id))
    .filter(
      (row) =>
        row.settlement === "open" &&
        row.dispatch_id !== run.coordinator_dispatch_id,
    )
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  if (open.length === 0) return [];
  const foreign = await foreignHosts(db, open, input);
  if (foreign !== null) return foreign;
  const workers = memoWorkers(orca, run.run_id);
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const rows = await workers();
  if (rows === null)
    return refuse(
      "owed_work",
      `the worker list for Run ${run.run_id} could not be read`,
      [closeCommand(input)],
    );
  const rowOf = (row: Dispatch) =>
    rows.find((item) => item.dispatchId === row.dispatch_id);
  const settled: string[] = [];
  for (const row of open) {
    const found = rowOf(row);
    if (found === undefined || abandonEnded(found)) continue;
    const stopped = await stopDispatch(db, orca, log, {
      dispatch: row,
      cause: { reason: abandonReason },
      requestId: null,
      unknown: false,
      workers,
      host: input.host,
      now: input.now,
    });
    if (stopped.kind === "wait")
      return refuse("owed_work", stopped.message, [closeCommand(input)]);
    settled.push(row.dispatch_id);
  }
  for (const row of open) {
    const found = rowOf(row);
    if (found !== undefined && !abandonEnded(found)) continue;
    await settleStopped(db, run, row, workerFields(found), input);
    settled.push(row.dispatch_id);
  }
  return settled;
}

const StopReason = z.looseObject({ reason: z.literal(abandonReason) });

async function record(
  db: Db,
  run: Run,
  settled: readonly string[],
  input: AbandonInput,
): Promise<Refused | null> {
  return db.transaction(async (tx) => {
    const current = await tx.lockRun(run.run_id);
    if (current === null) throw new Error(`Run ${run.run_id} vanished`);
    if (current.owner_generation !== input.generation)
      return refuse(
        "owner_generation_stale",
        `--generation ${input.generation} differs from the Run's owner generation ${current.owner_generation}`,
        [
          `pod takeover story:${run.story_external_id} if this session should own the Run`,
        ],
      );
    if ((await abandonRecord(tx, run.run_id)) !== null) return null;
    const open = (await tx.listTasks(run.run_id)).filter(
      (task) => !finishedTasks.includes(task.state),
    );
    const stopped = (await tx.listEvents(run.run_id, "stop")).flatMap(
      (event) =>
        event.dispatch_id !== null &&
        StopReason.safeParse(event.payload).success
          ? [event.dispatch_id]
          : [],
    );
    await tx.appendEvent({
      type: "cancel",
      ts: input.now(),
      host: input.host,
      run_id: run.run_id,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: Json.parse({
        reason: abandonReason,
        text: input.reason,
        actor: input.actor,
        tasks: open.map((task) => ({
          task_id: task.task_id,
          from: task.state,
        })),
        dispatches: [...new Set([...settled, ...stopped])],
      }),
      source: { kind: "command", verb: "run close" },
    });
    for (const task of open) {
      if (task.state !== "hold") await moveTask(tx, task.task_id, "hold");
      await moveTask(tx, task.task_id, "superseded");
    }
    return null;
  });
}

/** Settles the Run's open Dispatches and supersedes its open Tasks; a refusal before the settle writes nothing. */
export async function abandonRun(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  run: Run,
  input: AbandonInput,
): Promise<Refused | null> {
  const tasks = await db.listTasks(run.run_id);
  const gates = input.person ? [] : personGates(tasks, input);
  if (gates.length > 0)
    return refuse(
      "activation_needs_person",
      `${input.actor} is an agent Seat, and Run ${run.run_id} waits at a person's gate: ${gates.join(", ")}`,
      [`a person runs ${closeCommand(input)}`],
    );
  const owed = await held(db, run, tasks, input);
  if (owed !== null) return owed;
  const settled = await settleOpen(db, orca, log, run, input);
  if (!Array.isArray(settled)) return settled;
  return record(db, run, settled, input);
}
