import { z } from "zod";
import type { Run, Task } from "../domain/ledger.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  DecisionSource,
  Latest,
  noReworkEdge,
  recordOutcome,
  rework,
  reworkFinished,
  type OutcomeInput,
} from "./project.ts";

export interface ReworkContext {
  run: Run;
  host: string;
  now: () => Date;
}

const source = { kind: "command", verb: "check" } as const;

const AgreedRework = z.looseObject({
  text: z.string(),
  changes: z.array(z.string()),
});

const HeldDecision = z.looseObject({
  reason: z.literal(noReworkEdge),
  decision_id: z.string().nullable(),
});

async function agreedChange(
  db: Repo,
  task: Task,
): Promise<{ decisionId: string; note: string } | null> {
  const event = await db.latestEvent(task.run_id, "outcome", {
    taskId: task.task_id,
  });
  if (Latest.safeParse(event?.payload).data?.outcome !== "rework") return null;
  const decided = DecisionSource.safeParse(event?.source);
  if (!decided.success) return null;
  const decisionId = decided.data.decision_id;
  const agreed = AgreedRework.safeParse(
    (await db.getDecision(decisionId))?.outcome,
  );
  if (!agreed.success) return null;
  return {
    decisionId,
    note: [
      `Agreed plan change from Decision ${decisionId}: ${agreed.data.text}`,
      "Changes:",
      ...agreed.data.changes.map((change) => `- ${change}`),
    ].join("\n"),
  };
}

const ReceiptFail = z.looseObject({
  outcome: z.literal("FAIL"),
  edge: z.looseObject({
    to: z.string(),
    new_task: z.literal(true),
    then: z.string().nullable(),
  }),
});
const ReceiptSource = z.looseObject({
  kind: z.literal("receipt"),
  receipt_id: z.number(),
});
const HqaReceipt = z.looseObject({ kind: z.literal("tracker_comment") });

async function receiptFail(
  db: Repo,
  task: Task,
): Promise<{ receipt_id: number } | null> {
  const event = await db.latestEvent(task.run_id, "outcome", {
    taskId: task.task_id,
  });
  const failed = ReceiptFail.safeParse(event?.payload);
  const cited = ReceiptSource.safeParse(event?.source);
  if (!failed.success || !cited.success) return null;
  const { receipt_id } = cited.data;
  const receipt = (await db.listGateReceipts(task.run_id)).find(
    (row) => row.id === receipt_id,
  );
  if (
    receipt?.sync_state !== "synced" ||
    !HqaReceipt.safeParse(receipt.source).success
  )
    return null;
  const { to, then } = failed.data.edge;
  const steps = then === null ? [to] : [to, then];
  return (await reworkFinished(db, task, steps)) ? null : { receipt_id };
}

async function heldStep(db: Repo, task: Task): Promise<string | null> {
  const event = await db.latestEvent(task.run_id, "hold", {
    taskId: task.task_id,
  });
  const held = HeldDecision.safeParse(event?.payload);
  if (!held.success) return null;
  return `Decision ${held.data.decision_id ?? "unknown"} agreed a plan rework; step ${task.step_id} has no rework edge; Task ${task.task_id} is on hold; change it with pod decide --effect change_spec --supersedes`;
}

export async function followReworks(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  context: ReworkContext,
): Promise<string[]> {
  const steps: string[] = [];
  const tasks = await db.listTasks(context.run.run_id);
  for (const task of tasks) {
    if (task.state === "hold") {
      const step = await heldStep(db, task);
      if (step !== null) steps.push(step);
      continue;
    }
    if (task.state !== "failed") continue;
    if (tasks.some((row) => row.rework_of === task.task_id)) continue;
    const change = await agreedChange(db, task);
    const fail = change === null ? await receiptFail(db, task) : null;
    const replay: OutcomeInput | null =
      change !== null
        ? {
            task: task.task_id,
            outcome: "rework",
            at: context.now(),
            host: context.host,
            source: { kind: "decision", decision_id: change.decisionId },
          }
        : fail !== null
          ? {
              task: task.task_id,
              outcome: "FAIL",
              at: context.now(),
              host: context.host,
              source: { kind: "receipt", receipt_id: fail.receipt_id },
            }
          : null;
    if (replay === null) continue;
    const recorded = await db.transaction(async (tx) => {
      await tx.lockRun(task.run_id);
      return recordOutcome(tx, replay);
    });
    if (recorded.kind !== "rework") continue;
    const made = await rework(
      {
        db,
        orca,
        log,
        process: recorded.plan.read.revision,
        host: context.host,
        command: "pod check",
        source,
        now: context.now,
      },
      change === null ? recorded.plan : { ...recorded.plan, note: change.note },
    );
    if (!made.ok) steps.push(made.refusal.message, ...made.refusal.nextSteps);
  }
  return steps;
}
