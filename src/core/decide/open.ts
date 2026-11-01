import { z } from "zod";
import type { NewRevision, Revision } from "../domain/config.ts";
import {
  DecisionEffect,
  parseDecisionState,
  type DecisionRow,
  type DecisionState,
} from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Run, Task } from "../domain/ledger.ts";
import {
  authorizationOf,
  budgetFields,
  budgetOf,
  reservedOf,
} from "../domain/policy.ts";
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
  taskSpecReference,
  ManifestReference,
} from "../manifest/references.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { readProcess } from "../process/project.ts";
import { appendDecisionEvent } from "./event.ts";
import {
  firstUnauthorized,
  reservedCheck,
  type ReservedHit,
} from "./reserved.ts";
import { next, type DecisionEvent } from "./table.ts";
import { failDecision } from "./advance.ts";
import { spentNow } from "./budget.ts";
import { changeSpecStates } from "./effects.ts";
import { optionsText, renderTemplate, Templates } from "./templates.ts";

export interface Limits {
  decision_rounds: number;
  decision_budget: Json;
}

export interface DecideInput {
  task: string;
  category: string;
  effect: DecisionEffect;
  spec?: NewRevision | null;
  question: string;
  options: readonly string[];
  generation: number;
  opKey: string | null;
  supersedes?: string | null;
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
  reserved: { class: string; member: string } | null;
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
      reserved: z
        .object({ class: z.string(), member: z.string() })
        .nullable()
        .default(null),
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
      ...(input.supersedes == null ? {} : { supersedes: input.supersedes }),
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
    const old =
      input.supersedes == null
        ? null
        : await supersedable(tx, run, input.supersedes, input.effect);
    if (old !== null && "code" in old) return record(old);
    const found = await precondition(tx, current, input.effect, old?.id);
    if (found !== null) return record(found);
    const references = await pinnedReferences(tx, run, current, input.effect);
    if (references === null)
      return record(notReady(current, "has no delivery"));
    if (input.spec != null) {
      const { revision } = await tx.insertRevision(input.spec);
      references.push(taskSpecReference(revision));
    }
    await tx.insertOperation({
      op_key: opKey,
      intent: "decide",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({ request, decision_id: decisionId }),
    });
    const policy = await policyOf(tx, run);
    const limits = input.limits(policy);
    if (old !== null)
      await supersede(tx, old, decisionId, { at: now, host: input.host });
    const hits = reservedCheck(reservedOf(policy), {
      category: input.category,
      question: input.question,
      options: input.options,
      spec: input.spec?.value ?? null,
    });
    const { manifest } = await recordManifest(tx, {
      run_id: run.run_id,
      task_id: current.task_id,
      decision_id: decisionId,
      parent_id: null,
      created_at: now,
      references,
    });
    const row: DecisionRow = {
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
      budget: old === null ? limits.decision_budget : remainingBudget(old, now),
      spent: { wall_clock: 0, relaunches: 0, tool_calls: 0, context_tokens: 0 },
      supersedes_decision_id: old?.id ?? null,
      adoption: "pending",
      adoption_evidence: [],
      created_at: now,
      closed_at: null,
    };
    await tx.insertDecision(row);
    const route = routeOf(hits, authorizationOf(policy, run.story_external_id));
    if (route !== null && route.routed !== "authorized")
      return settleReserved(tx, row, route.routed, route.hit, {
        opKey,
        request,
        at: now,
        host: input.host,
      });
    const step = next(
      { kind: "requested" },
      route === null ? "open" : "authorized",
      limits.decision_rounds,
    );
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
  if (!seat.ok) {
    if (seat.runtimeFailure === true)
      return {
        ok: false,
        refusal: await needsHuman(db, decision.id, seat.refusal, input),
      };
    return seat;
  }
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
    reserved: null,
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

type Routed =
  "authorized" | "reserved_deny" | "reserved_needs_human" | "unauthorized";

function routeOf(
  hits: readonly ReservedHit[],
  authorization: ReturnType<typeof authorizationOf>,
): { routed: Routed; hit: ReservedHit } | null {
  const [first] = hits;
  if (first === undefined) return null;
  if (first.class === "deny") return { routed: "reserved_deny", hit: first };
  if (first.class === "needs_human")
    return { routed: "reserved_needs_human", hit: first };
  const missing = firstUnauthorized(hits, authorization);
  return missing === null
    ? { routed: "authorized", hit: first }
    : { routed: "unauthorized", hit: missing };
}

async function moveReserved(
  tx: Repo,
  decision: DecisionRow,
  from: DecisionState,
  event: DecisionEvent,
  hit: ReservedHit,
  context: { at: Date; host: string },
): Promise<DecisionState> {
  const step = next(from, event, 3);
  if (step === null) throw new Error(`the decision table has no ${event} row`);
  const settled = step.to.kind !== "reserved_needs_human";
  const moved = await tx.updateDecisionState(decision.id, {
    from: from.kind,
    to: step.to,
    outcome: settled
      ? { result: step.to.kind, text: `${step.to.kind}: ${hit.member}` }
      : null,
    closed_at: settled ? context.at : null,
  });
  if (!moved)
    throw new Error(`Decision ${decision.id} moved from ${from.kind}`);
  await appendDecisionEvent(
    tx,
    decision,
    step.to,
    context,
    { reserved: { class: hit.class, member: hit.member } },
    "decide",
  );
  return step.to;
}

async function settleReserved(
  tx: Repo,
  decision: DecisionRow,
  routed: Exclude<Routed, "authorized">,
  hit: ReservedHit,
  context: {
    opKey: string;
    request: { task_id: string; category: string; effect: DecisionEffect };
    at: Date;
    host: string;
  },
): Promise<Opened> {
  const reserved = { class: hit.class, member: hit.member };
  const requested: DecisionState = { kind: "requested" };
  if (routed === "reserved_deny") {
    await moveReserved(tx, decision, requested, routed, hit, context);
    const refusal: Refusal = {
      code: "decision_denied",
      message: `Decision ${decision.id} is reserved_denied: ${hit.member} is a Reserved deny member`,
      nextSteps: [
        `only the operator acts on ${hit.member}, outside pod decide`,
      ],
    };
    await tx.moveOperation(
      context.opKey,
      "refused",
      Json.parse({
        request: context.request,
        decision_id: decision.id,
        ...refusal,
      }),
      context.at,
    );
    return { kind: "refused", refusal };
  }
  const held = await moveReserved(
    tx,
    decision,
    requested,
    routed,
    hit,
    context,
  );
  const to = await moveReserved(
    tx,
    decision,
    held,
    "policy_required",
    hit,
    context,
  );
  const result: DecideResult = {
    decision_id: decision.id,
    run_id: decision.run_id,
    task_id: decision.task_id ?? "",
    state: to.kind,
    manifest_id: decision.manifest_id,
    decider_dispatch_id: "",
    round: 0,
    reserved,
  };
  await tx.moveOperation(
    context.opKey,
    "done",
    Json.parse({ request: context.request, decision_id: decision.id, result }),
    context.at,
  );
  return { kind: "done", result };
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

async function supersedable(
  tx: Repo,
  run: Run,
  id: string,
  effect: DecisionEffect,
): Promise<DecisionRow | Refusal> {
  const old = await tx.getDecision(id);
  const usage = (why: string): Refusal => ({
    code: "usage",
    message: `--supersedes ${id} ${why}`,
    nextSteps: [
      "--supersedes names an open accept_plan Decision or an agreed Decision of the same Run",
    ],
  });
  if (effect !== "change_spec") return usage("needs --effect change_spec");
  if (old === null) return usage("names no Decision");
  if (old.run_id !== run.run_id) return usage(`is on Run ${old.run_id}`);
  const state = parseDecisionState(old.state, old.reason, old.outcome);
  if (
    next(state, "supersede", 3, {
      effect: DecisionEffect.parse(old.effect),
      by: id,
    }) === null
  )
    return usage(`is a ${old.effect} Decision in ${old.state}`);
  return old;
}

async function supersede(
  tx: Repo,
  old: DecisionRow,
  by: string,
  context: { at: Date; host: string },
): Promise<void> {
  const state = parseDecisionState(old.state, old.reason, old.outcome);
  const step = next(state, "supersede", 3, {
    effect: DecisionEffect.parse(old.effect),
    by,
  });
  if (step === null) throw new Error(`Decision ${old.id} cannot be superseded`);
  const moved = await tx.updateDecisionState(old.id, {
    from: old.state,
    to: step.to,
    outcome: { result: "superseded", text: `superseded by ${by}`, by },
    closed_at: context.at,
  });
  if (!moved) throw new Error(`Decision ${old.id} moved from ${old.state}`);
  await appendDecisionEvent(
    tx,
    old,
    step.to,
    context,
    { superseded_by: by },
    "decide",
  );
}

function remainingBudget(old: DecisionRow, now: Date): Json {
  const budget = budgetOf(old.budget);
  const spent = spentNow(old, now);
  const left: Record<string, number> = {};
  for (const field of budgetFields)
    left[field] = Math.max(0, budget[field] - spent[field]);
  return left;
}

async function precondition(
  tx: Repo,
  task: Task,
  effect: DecisionEffect,
  superseded?: string,
): Promise<Refusal | null> {
  if (effect === "accept_plan" && task.state !== "delivered")
    return notReady(task, "is not delivered");
  if (effect === "change_spec" && !changeSpecStates.includes(task.state))
    return notReady(task, `is ${task.state}`);
  const { step } = await readProcess(tx, task, "agreed");
  if (effect === "accept_plan" && step.decision === undefined)
    return notReady(task, `step ${step.id} has no decision`);
  if (effect === "change_spec" && step.type !== "worker")
    return notReady(task, `step ${step.id} is ${step.type}, not a worker step`);
  const open = (await tx.openDecisionsForRun(task.run_id)).find(
    (row) => row.task_id === task.task_id && row.id !== superseded,
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
  effect: DecisionEffect,
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
  if (delivery === null && effect === "accept_plan") return null;
  return [
    storyReference(story),
    runReference(run),
    taskReference(task),
    revisionReference(crew),
    revisionReference(process),
    revisionReference(policy),
    ...(delivery === null ? [] : [deliveryReference(delivery)]),
  ];
}

export async function needsHuman(
  db: Db,
  decisionId: string,
  refusal: Refusal,
  context: { host: string; now: () => Date },
): Promise<Refusal> {
  await db.transaction((tx) =>
    failDecision(tx, {
      decision: decisionId,
      at: context.now(),
      host: context.host,
    }),
  );
  return {
    ...refusal,
    nextSteps: [
      ...refusal.nextSteps,
      `Decision ${decisionId} is needs_human: runtime-failure`,
    ],
  };
}
