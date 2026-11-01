import { z } from "zod";
import { parseDecisionState, type DecisionRow } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Run, Task } from "../domain/ledger.ts";
import type { ReceiptLog } from "../dispatch/decision-seats.ts";
import { stopForSupersede } from "../dispatch/stop.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, WorkerRow } from "../ports/orca.ts";
import {
  applySupersede,
  createReplacement,
  replacementDeps,
  replacementOpKey,
  supersedeOpKey,
} from "../process/project.ts";
import { changeSpecStates, SupersedeRef } from "./effects.ts";
import { appendDecisionEvent } from "./event.ts";

export interface SupersedeContext {
  run: Run;
  workers: () => Promise<WorkerRow[] | null>;
  host: string;
  now: () => Date;
}

const TaskSpecValue = z.looseObject({ spec: z.string() });

export async function followSupersedes(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  context: SupersedeContext,
): Promise<string[]> {
  const steps: string[] = [];
  for (const operation of await db.listOperations(["decide"], ["pending"])) {
    const ref = SupersedeRef.safeParse(operation.result_ref);
    if (!ref.success || ref.data.run_id !== context.run.run_id) continue;
    const step = await followOne(db, orca, log, context, ref.data);
    if (step !== null) steps.push(step);
  }
  return steps;
}

async function followOne(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  context: SupersedeContext,
  ref: SupersedeRef,
): Promise<string | null> {
  const opKey = supersedeOpKey(ref.decision_id);
  const decision = await db.getDecision(ref.decision_id);
  const task = await db.getTask(ref.task_id);
  if (decision === null || task === null)
    throw new Error(`supersede ${opKey} lost its Decision or Task`);
  if (!changeSpecStates.includes(task.state))
    return db.transaction((tx) =>
      refuseEffect(tx, opKey, ref, decision, task, context),
    );
  const save = (next: Partial<SupersedeRef>) =>
    db.moveOperation(
      opKey,
      "pending",
      Json.parse({ ...ref, ...next }),
      context.now(),
    );

  const open = (await db.listDispatches(task.run_id)).find(
    (row) => row.task_id === task.task_id && row.settlement === "open",
  );
  if (open !== undefined) {
    const stopped = await stopForSupersede(db, orca, log, {
      dispatch: open,
      decisionId: decision.id,
      requestId: ref.stop_request_id,
      unknown: ref.stop_unknown,
      workers: context.workers,
      host: context.host,
      now: context.now,
    });
    if (stopped.kind === "wait") {
      await save({
        stop_request_id: stopped.requestId,
        stop_unknown: stopped.unknown,
      });
      return stopped.message;
    }
  }

  const revision = await db.getRevision(ref.revision_id);
  const spec = TaskSpecValue.safeParse(revision?.value);
  const snapshot = await db.getSnapshot(task.run_id);
  const process =
    snapshot === null
      ? null
      : await db.getRevision(snapshot.process_revision_id);
  if (revision === null || !spec.success || process === null)
    throw new Error(`supersede ${opKey} lost its Task spec or process`);
  const made = await createReplacement(
    { db, orca, log, process, now: context.now },
    {
      runId: task.run_id,
      step: {
        id: task.step_id,
        type: "worker",
        role: task.role,
        needs: [],
        spec: spec.data.spec,
      },
      opKey: replacementOpKey(task, ref.create_attempt),
      deps: replacementDeps(await db.listTasks(task.run_id), task),
    },
  );
  if (made.kind === "retry") {
    await save({ create_attempt: ref.create_attempt + 1 });
    return made.message;
  }
  if (made.kind === "wait") return made.message;

  return db.transaction(async (tx) => {
    await tx.lockRun(task.run_id);
    if ((await tx.getOperation(opKey))?.status !== "pending") return null;
    const current = await tx.getTask(task.task_id);
    if (current === null) throw new Error(`Task ${task.task_id} vanished`);
    if (!changeSpecStates.includes(current.state))
      return refuseEffect(tx, opKey, ref, decision, current, context);
    const at = context.now();
    await activate(tx, current, ref.revision_id, decision.id, context.host, at);
    await applySupersede(tx, {
      superseded: current,
      replacementId: made.taskId,
      revisionId: ref.revision_id,
      at,
    });
    await appendDecisionEvent(
      tx,
      decision,
      stateOf(decision),
      { at, host: context.host },
      {
        revision_id: ref.revision_id,
        replacement_task_id: made.taskId,
      },
    );
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ ...ref, replacement_task_id: made.taskId }),
      at,
    );
    return null;
  });
}

function stateOf(decision: DecisionRow) {
  return parseDecisionState(decision.state, decision.reason);
}

async function activate(
  tx: Repo,
  task: Task,
  revisionId: string,
  decisionId: string,
  host: string,
  at: Date,
): Promise<void> {
  const key = {
    scope: "run" as const,
    scope_ref: task.run_id,
    kind: "task" as const,
    name: task.lineage_id,
  };
  const current = await tx.getActivation(key);
  const outcome = await tx.activate({
    ...key,
    expected: current?.revision_id ?? null,
    revision_id: revisionId,
    bundle_id: null,
    activated_by: "pod check",
    activated_at: at,
  });
  if (!outcome.ok)
    throw new Error(
      `Task spec activation for ${task.lineage_id} moved to ${outcome.active ?? "none"}`,
    );
  await tx.appendEvent({
    type: "activation",
    ts: at,
    host,
    run_id: task.run_id,
    task_id: task.task_id,
    dispatch_id: null,
    op_key: supersedeOpKey(decisionId),
    payload: {
      ...key,
      revision_id: revisionId,
      previous_revision_id: outcome.previous,
      bundle_id: null,
      decision_id: decisionId,
    },
    source: { kind: "command", verb: "check" },
  });
}

async function refuseEffect(
  tx: Repo,
  opKey: string,
  ref: SupersedeRef,
  decision: DecisionRow,
  task: Task,
  context: SupersedeContext,
): Promise<string> {
  const at = context.now();
  const message = `Task ${task.task_id} is ${task.state}; the change_spec effect of Decision ${decision.id} is not applied`;
  await tx.moveOperation(
    opKey,
    "refused",
    Json.parse({
      ...ref,
      code: "task_not_ready",
      message,
      nextSteps: [`Task state ${task.state}`],
    }),
    at,
  );
  await appendDecisionEvent(
    tx,
    decision,
    stateOf(decision),
    { at, host: context.host },
    {
      revision_id: ref.revision_id,
      replacement_task_id: null,
      applied: false,
    },
  );
  return message;
}
