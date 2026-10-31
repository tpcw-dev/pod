import { z } from "zod";
import type { Revision } from "../domain/config.ts";
import type { DecisionEffect } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Run, Task } from "../domain/ledger.ts";
import {
  refuse,
  RefusalCode,
  type Outcome,
  type Refusal,
} from "../domain/outcome.ts";
import {
  decideOpKey,
  decisionIdOf,
  openDecisionSeat,
  type ReceiptLog,
} from "../dispatch/decision-seats.ts";
import { recordManifest } from "../manifest/record.ts";
import {
  deliveryReference,
  manifestText,
  revisionReference,
  runReference,
  storyReference,
  taskReference,
  ManifestReference,
} from "../manifest/references.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { readProcess } from "../process/project.ts";
import { next } from "./table.ts";
import { renderTemplate, Templates } from "./templates.ts";

export interface Limits {
  decision_rounds: number;
  decision_budget: Json;
}

export interface DecideInput {
  task: string;
  category: string;
  effect: DecisionEffect;
  question: string;
  options: readonly string[];
  generation: number;
  opKey: string | null;
  host: string;
  capacity: number;
  templates: Revision | null;
  limits: (policyValue: unknown) => Limits;
  now: () => Date;
}

export interface DecideResult {
  decision_id: string;
  run_id: string;
  task_id: string;
  state: string;
  manifest_id: string;
  decider_dispatch_id: string;
  round: number;
}

const Recorded = z.looseObject({
  request: z.looseObject({ task_id: z.string(), category: z.string() }),
  decision_id: z.string().optional(),
  result: z
    .looseObject({
      decision_id: z.string(),
      run_id: z.string(),
      task_id: z.string(),
      state: z.string(),
      manifest_id: z.string(),
      decider_dispatch_id: z.string(),
      round: z.int(),
    })
    .optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

type Opened =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "done"; result: DecideResult }
  | { kind: "send"; decisionId: string };

export function optionsText(options: readonly string[]): string {
  return options.map((option) => `- ${option}`).join("\n");
}

export async function openDecision(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: DecideInput,
): Promise<Outcome<DecideResult>> {
  const task = await db.getTask(input.task);
  if (task === null)
    return refuse("task_not_ready", `no Task ${input.task}`, ["pod brief"]);
  const templates = Templates.safeParse(input.templates?.value);
  if (input.templates === null || !templates.success)
    return refuse(
      "revision_not_found",
      "no active decision Revision for the Run's scope",
      [
        "pod config apply specs/decision/default.yaml --activate --scope global --expected-revision none",
      ],
    );
  const { version } = await orca.version();
  const opKey =
    input.opKey ??
    decideOpKey({
      run_id: task.run_id,
      task_id: task.task_id,
      category: input.category,
    });
  const decisionId = decisionIdOf(opKey);
  const request = {
    task_id: task.task_id,
    category: input.category,
    effect: input.effect,
  };
  const now = input.now();

  const opened = await db.transaction(async (tx): Promise<Opened> => {
    const run = await tx.lockRun(task.run_id);
    if (run === null) throw new Error(`Run ${task.run_id} vanished`);
    const existing = await tx.getOperation(opKey);
    const record = async (found: Refusal): Promise<Opened> => {
      if (existing === null) {
        await tx.insertOperation({
          op_key: opKey,
          intent: "decide",
          owner_generation: input.generation,
          at: now,
          result_ref: { request },
        });
        await tx.moveOperation(opKey, "refused", { request, ...found }, now);
      }
      return { kind: "refused", refusal: found };
    };
    if (input.generation !== run.owner_generation)
      return record({
        code: "owner_generation_stale",
        message: `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
        nextSteps: [
          `pod takeover story:${run.story_external_id} if this session should own the Run`,
        ],
      });
    if (existing !== null) return replay(existing, opKey, request.task_id);
    const current = await tx.getTask(task.task_id);
    if (current === null) throw new Error(`Task ${task.task_id} vanished`);
    const found = await precondition(tx, current);
    if (found !== null) return record(found);
    const references = await pinnedReferences(tx, run, current);
    if (references === null)
      return record(notReady(current, "has no delivery"));
    await tx.insertOperation({
      op_key: opKey,
      intent: "decide",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({ request, decision_id: decisionId }),
    });
    const policy = await policyOf(tx, run);
    const limits = input.limits(policy);
    const { manifest } = await recordManifest(tx, {
      run_id: run.run_id,
      task_id: current.task_id,
      decision_id: decisionId,
      parent_id: null,
      created_at: now,
      references,
    });
    await tx.insertDecision({
      id: decisionId,
      run_id: run.run_id,
      task_id: current.task_id,
      category: input.category,
      effect: input.effect,
      question: input.question,
      options: [...input.options],
      manifest_id: manifest.id,
      state: "requested",
      outcome: null,
      reason: null,
      binding: "run",
      budget: limits.decision_budget,
      spent: { wall_clock: 0, relaunches: 0, tool_calls: 0, context_tokens: 0 },
      supersedes_decision_id: null,
      adoption: "pending",
      adoption_evidence: [],
      created_at: now,
      closed_at: null,
    });
    const step = next({ kind: "requested" }, "open", limits.decision_rounds);
    if (step === null) throw new Error("the decision table has no open row");
    await tx.updateDecisionState(decisionId, {
      from: "requested",
      to: step.to,
      outcome: null,
      closed_at: null,
    });
    for (const row of await tx.listDispatches(run.run_id))
      if (row.task_id === current.task_id && row.activity === "running")
        await tx.setDispatchActivity(row.dispatch_id, "waiting");
    return { kind: "send", decisionId };
  });

  if (opened.kind === "refused") return { ok: false, refusal: opened.refusal };
  if (opened.kind === "done")
    return { ok: true, result: opened.result, opKey, orca: version };
  return sendRoundOpen(db, orca, log, {
    ...input,
    opKey,
    decisionId: opened.decisionId,
    text: templates.data,
    version,
  });
}

async function sendRoundOpen(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: Omit<DecideInput, "templates"> & {
    opKey: string;
    decisionId: string;
    text: Templates;
    version: string;
  },
): Promise<Outcome<DecideResult>> {
  const decision = await db.getDecision(input.decisionId);
  const run = decision === null ? null : await db.getRun(decision.run_id);
  const manifest =
    decision === null ? null : await db.getManifest(decision.manifest_id);
  if (decision === null || run === null || manifest === null)
    throw new Error(`Decision ${input.decisionId} lost its Run or manifest`);
  const fields = {
    decision_id: decision.id,
    question: decision.question,
    options: optionsText(z.array(z.string()).parse(decision.options)),
    manifest_id: manifest.id,
    manifest: manifestText(
      z.array(ManifestReference).parse(manifest.references),
    ),
    round: "1",
  };
  const seat = await openDecisionSeat(db, orca, log, {
    run,
    decisionId: decision.id,
    role: "decider",
    spec: renderTemplate(input.text.decider, fields),
    manifestId: manifest.id,
    generation: input.generation,
    host: input.host,
    capacity: input.capacity,
    now: input.now,
  });
  if (!seat.ok) return seat;
  log.at({
    run_id: run.run_id,
    task_id: decision.task_id,
    op_key: input.opKey,
  });
  const sent = await orca.send({
    to: `dispatch:${seat.dispatch.dispatch_id}`,
    subject: `decision ${decision.id} round 1`,
    body: renderTemplate(input.text.round_open, fields),
  });
  if (sent.exitCode !== 0)
    return refuse(
      "failed",
      `send of round 1 for Decision ${decision.id} failed`,
      [`run pod decide again with --op-key ${input.opKey}`],
    );
  const result: DecideResult = {
    decision_id: decision.id,
    run_id: run.run_id,
    task_id: decision.task_id ?? "",
    state: "round:1",
    manifest_id: manifest.id,
    decider_dispatch_id: seat.dispatch.dispatch_id,
    round: 1,
  };
  await db.moveOperation(
    input.opKey,
    "done",
    Json.parse({
      request: {
        task_id: result.task_id,
        category: input.category,
        effect: input.effect,
      },
      decision_id: decision.id,
      send: sent.result ?? null,
      result,
    }),
    input.now(),
  );
  return { ok: true, result, opKey: input.opKey, orca: input.version };
}

function replay(
  existing: { intent: string; status: string; result_ref: Json | null },
  opKey: string,
  taskId: string,
): Opened {
  const ref = Recorded.safeParse(existing.result_ref);
  if (
    existing.intent !== "decide" ||
    !ref.success ||
    ref.data.request.task_id !== taskId
  )
    return {
      kind: "refused",
      refusal: {
        code: "duplicate_op",
        message: `op key ${opKey} belongs to another intent or request`,
        nextSteps: ["pass a new --op-key"],
      },
    };
  if (existing.status === "refused")
    return {
      kind: "refused",
      refusal: {
        code: ref.data.code ?? "failed",
        message: ref.data.message ?? `op key ${opKey} was refused`,
        nextSteps: ref.data.nextSteps ?? [],
      },
    };
  if (existing.status === "done" && ref.data.result !== undefined)
    return { kind: "done", result: ref.data.result };
  if (ref.data.decision_id === undefined)
    return {
      kind: "refused",
      refusal: {
        code: "failed",
        message: `op key ${opKey} recorded no Decision`,
        nextSteps: ["pod check"],
      },
    };
  return { kind: "send", decisionId: ref.data.decision_id };
}

function notReady(task: Task, why: string): Refusal {
  return {
    code: "task_not_ready",
    message: `Task ${task.task_id} ${why}`,
    nextSteps: [`Task state ${task.state}`],
  };
}

async function precondition(tx: Repo, task: Task): Promise<Refusal | null> {
  if (task.state !== "delivered") return notReady(task, "is not delivered");
  const { step } = await readProcess(tx, task, "agreed");
  if (step.decision === undefined)
    return notReady(task, `step ${step.id} has no decision`);
  const open = (await tx.openDecisionsForRun(task.run_id)).find(
    (row) => row.task_id === task.task_id,
  );
  if (open === undefined) return null;
  return {
    code: "duplicate_op",
    message: `Task ${task.task_id} already has open Decision ${open.id}`,
    nextSteps: [`pod check --wait --decision ${open.id}`],
  };
}

async function policyOf(tx: Repo, run: Run): Promise<unknown> {
  const snapshot = await tx.getSnapshot(run.run_id);
  const policy =
    snapshot === null
      ? null
      : await tx.getRevision(snapshot.policy_revision_id);
  return policy?.value ?? null;
}

async function pinnedReferences(
  tx: Repo,
  run: Run,
  task: Task,
): Promise<ManifestReference[] | null> {
  const snapshot = await tx.getSnapshot(run.run_id);
  const story = await tx.getStory(run.story_provider, run.story_external_id);
  const crew =
    snapshot === null ? null : await tx.getRevision(snapshot.crew_revision_id);
  const process =
    snapshot === null
      ? null
      : await tx.getRevision(snapshot.process_revision_id);
  const policy =
    snapshot === null
      ? null
      : await tx.getRevision(snapshot.policy_revision_id);
  if (story === null || crew === null || process === null || policy === null)
    throw new Error(`Run ${run.run_id} lost its Story or pinned Revisions`);
  const delivery = await tx.latestEvent(run.run_id, "delivery", {
    taskId: task.task_id,
  });
  if (delivery === null) return null;
  return [
    storyReference(story),
    runReference(run),
    taskReference(task),
    revisionReference(crew),
    revisionReference(process),
    revisionReference(policy),
    deliveryReference(delivery),
  ];
}
