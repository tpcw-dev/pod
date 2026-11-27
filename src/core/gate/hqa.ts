import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { GateReceipt, Run, Task } from "../domain/ledger.ts";
import { refuse, type Checked, type Refused } from "../domain/outcome.ts";
import type { TaskState } from "../domain/task-state.ts";
import { fence } from "../check/fence.ts";
import { moveTask } from "../ledger/move-task.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import type {
  StoryRef,
  TrackerComment,
  TrackerPort,
} from "../ports/tracker.ts";
import {
  followOutcome,
  readProcess,
  recordOutcome,
  type OutcomeResult,
  type Recorded,
} from "../process/project.ts";
import { settleRuntime } from "../process/settle.ts";
import { singleActive } from "../config/active.ts";
import { readBypass, type BypassResult } from "./bypass.ts";
import {
  candidateSha,
  contentHash,
  decideStep,
  delegatedTrailer,
  delegatesOf,
  findVerdictComment,
  gateOf,
  hashOf,
  pinnedConfig,
  principalsOf,
  verdictComments,
  verifyDelegated,
  verifySource,
  type GateKeeper,
  type SourceRefusal,
} from "./receipt.ts";
import type { StoryComments } from "./ruling.ts";

export class HqaAmbiguous extends Error {
  constructor(readonly waiting: readonly { task: string; gate: string }[]) {
    super(
      `more than one delivered Task waits on an HQA gate: ${waiting
        .map((row) => `${row.task} (${row.gate})`)
        .join(", ")}`,
    );
  }
}

export interface HqaInput {
  story: StoryRef;
  generation: number;
  host: string;
  hostName: string;
  bypassPath: string;
  principal: string;
  command: string;
  now: () => Date;
}

export interface HqaResult {
  run_id: string;
  gate: string | null;
  receipt_id: number | null;
  op_key: string | null;
  outcome: OutcomeResult | null;
  nextSteps: string[];
}

const deployFields =
  "environment, deployment_id, deployed_revision, source_commit";
const bypassRemedy =
  "move the relay principal to a separate OS user or a separate host and run the bypass test (test/bypass) again";

const TrackerSource = z.looseObject({
  kind: z.literal("tracker_comment"),
  provider: z.string(),
  issue: z.string(),
  comment_id: z.string(),
  relayed_by: z.string().nullable(),
  content_hash: z.string(),
  readback_at: z.string(),
});

const PriorReceipt = z.looseObject({ receipt_id: z.number() });

const DeployEvent = z.looseObject({ deployed_revision: z.string() });

interface Waiting {
  task: Task;
  gate: string;
  keeper: GateKeeper;
}

async function waitingTasks(
  db: Db,
  run: Run,
  policy: unknown,
): Promise<{ waiting: Waiting[]; unkept: string[]; decisions: Task[] }> {
  const waiting: Waiting[] = [];
  const unkept: string[] = [];
  const decisions: Task[] = [];
  for (const task of await db.listTasks(run.run_id)) {
    const { step } = await readProcess(db, task, "PASS");
    if (step.decision !== undefined && task.state === "delivered")
      decisions.push(task);
    if (step.gate === undefined) continue;
    const open =
      task.state === "delivered" ||
      (task.state === "ready" && step.type === "human_wait");
    if (!open) continue;
    const keeper = gateOf(policy, step.gate);
    if (keeper === null) unkept.push(step.gate);
    else if (keeper.type === "HQA")
      waiting.push({ task, gate: step.gate, keeper });
  }
  return { waiting, unkept, decisions };
}

function unverified(
  gate: string,
  author: string | null,
  reason: SourceRefusal | "readback_failed" | "readback_differs",
): Refused {
  const bypass = reason === "bypass_missing" || reason === "bypass_failed";
  return refuse(
    "receipt_unverified_source",
    `gate ${gate}: the comment by ${author ?? "an unknown author"} is not a verified human source (${reason}); the Gate stays waiting`,
    bypass
      ? [bypassRemedy]
      : [
          `the human gatekeeper posts "${gate} PASS" or "${gate} FAIL" from their own account`,
        ],
  );
}

async function recordBypass(
  db: Db,
  run: Run,
  input: HqaInput,
  bypass: BypassResult | null,
): Promise<void> {
  if (bypass === null) return;
  const key = { check: "bypass", host: input.hostName, at: bypass.at };
  if ((await db.eventWith("receipt", key)) !== null) return;
  await db.appendEvent({
    type: "receipt",
    ts: input.now(),
    host: input.host,
    run_id: run.run_id,
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: { ...key, result: bypass.result },
    source: { kind: "command", verb: "bypass" },
  });
}

async function deployedRevision(
  db: Db,
  run: Run,
  gate: string,
  comment: TrackerComment,
): Promise<{ revision: string | null } | Refused> {
  if (gate !== "hqa_after_deploy") return { revision: null };
  const event = await db.latestEvent(run.run_id, "deploy");
  const deploy = DeployEvent.safeParse(event?.payload);
  if (!deploy.success)
    return refuse(
      "receipt_no_deploy",
      `gate ${gate} needs a deploy event on Run ${run.run_id}`,
      [
        `pod deploy record story:${run.story_external_id} --generation N with one line of ${deployFields}`,
      ],
    );
  const revision = deploy.data.deployed_revision;
  const named = /^Deployed:\s*(\S+)\s*$/m.exec(comment.body)?.[1];
  if (named !== undefined && named !== revision)
    return refuse(
      "receipt_stale_sha",
      `gate ${gate}: the comment names Deployed: ${named}, but the Run's deployed revision is ${revision}`,
      [`review the deployed revision ${revision} and post a new verdict`],
    );
  return { revision };
}

type Written = { recorded: Recorded; receipt_id: number };

interface Accepted {
  run: Run;
  waiting: Waiting;
  comment: TrackerComment;
  outcome: "PASS" | "FAIL";
  relayed_by: string | null;
  content_hash: string;
  readback_at: Date;
  deployed: string | null;
  opKey: string;
  actor: string;
  verb: "hqa record" | "check";
  delegated: { delegate: string; keeper_quote: string } | null;
}

export interface Settle {
  generation: number;
  host: string;
  command: string;
  now: () => Date;
  version: string;
}

async function write(
  tx: Repo,
  input: Pick<Settle, "generation" | "host" | "now">,
  accepted: Accepted,
): Promise<Written> {
  const { run, waiting, comment, opKey } = accepted;
  await tx.lockRun(run.run_id);
  await fence(tx, run.run_id, input.generation);
  const at = input.now();
  const outcomeInput = {
    task: waiting.task.task_id,
    outcome: accepted.outcome,
    at,
    host: input.host,
  };
  const prior = await tx.getOperation(opKey);
  const priorId = PriorReceipt.safeParse(prior?.result_ref).data?.receipt_id;
  if (priorId !== undefined) {
    const recorded = await recordOutcome(tx, {
      ...outcomeInput,
      source: { kind: "receipt", receipt_id: priorId },
    });
    return { recorded: { ...recorded, replayed: true }, receipt_id: priorId };
  }
  await tx.insertOperation({
    op_key: opKey,
    intent: "hqa",
    owner_generation: run.owner_generation,
    at,
  });
  const receipt: GateReceipt = await tx.insertGateReceipt({
    gate_id: waiting.gate,
    run_id: run.run_id,
    task_id: waiting.task.task_id,
    scope: "task",
    spec_revision_id: waiting.task.spec_revision_id,
    candidate_sha: (await candidateSha(tx, run.run_id)) ?? "",
    deployed_revision: accepted.deployed,
    keeper: waiting.keeper.keeper,
    outcome: accepted.outcome,
    source: {
      kind: "tracker_comment",
      provider: comment.ref.provider,
      workspace: null,
      issue: comment.ref.external_id,
      comment_id: comment.ref.comment_id,
      author_id: comment.authorId,
      relayed_by: accepted.relayed_by,
      content_hash: accepted.content_hash,
      readback_at: accepted.readback_at.toISOString(),
      ...accepted.delegated,
    },
    sync_state: "synced",
    created_at: at,
  });
  await tx.appendEvent({
    type: "receipt",
    ts: at,
    host: input.host,
    run_id: run.run_id,
    task_id: waiting.task.task_id,
    dispatch_id: null,
    op_key: opKey,
    payload: {
      receipt_id: receipt.id,
      gate: waiting.gate,
      outcome: accepted.outcome,
      comment_id: comment.ref.comment_id,
      actor: accepted.actor,
      ...(accepted.delegated === null ? {} : { keeper: waiting.keeper.keeper }),
    },
    source: { kind: "command", verb: accepted.verb },
  });
  if (waiting.task.state === "ready")
    await moveTask(tx, waiting.task.task_id, "delivered");
  const recorded = await recordOutcome(tx, {
    ...outcomeInput,
    source: { kind: "receipt", receipt_id: receipt.id },
  });
  await tx.moveOperation(
    opKey,
    "done",
    Json.parse({ receipt_id: receipt.id, task_id: waiting.task.task_id }),
    at,
  );
  return { recorded, receipt_id: receipt.id };
}

async function accept(
  db: Db,
  tracker: TrackerPort,
  run: Run,
  input: HqaInput,
  result: HqaResult,
): Promise<Accepted | Refused | null> {
  const pinned = await pinnedConfig(db, run.run_id);
  const { waiting, unkept, decisions } = await waitingTasks(
    db,
    run,
    pinned?.policy,
  );
  const [decision] = decisions;
  if (waiting.length === 0 && decision !== undefined)
    return refuse(
      "decision_not_gate",
      `Task ${decision.task_id} waits on a decision step; a Decision outcome is not an HQA PASS`,
      [decideStep(decision)],
    );
  if (waiting.length > 1)
    throw new HqaAmbiguous(
      waiting.map((row) => ({ task: row.task.task_id, gate: row.gate })),
    );
  const [gated] = waiting;
  if (gated === undefined) {
    result.nextSteps.push(
      ...unkept.map(
        (gate) => `gate ${gate} has no keeper and type in the Run's policy`,
      ),
      "no delivered Task waits on an HQA gate",
    );
    return null;
  }
  result.gate = gated.gate;
  const { keeper } = gated.keeper;
  if (input.principal !== keeper)
    return refuse(
      "receipt_unverified_source",
      `gate ${gated.gate} is kept by ${keeper}, and operator ${input.principal} is not its keeper; the Gate stays waiting`,
      [`${keeper} runs pod hqa record from their own shell`],
    );
  const read = await tracker.readback(input.story);
  if (!read.ok || read.result?.kind !== "story")
    return unverified(gated.gate, null, "readback_failed");
  const found = findVerdictComment(read.result.comments, gated.gate);
  if (found === null) {
    result.nextSteps.push(
      `gate ${gated.gate} waits for a comment whose first line is "${gated.gate} PASS" or "${gated.gate} FAIL"`,
    );
    return null;
  }
  const { comment } = found;
  if (delegatedTrailer(comment.body) !== null)
    return refuse(
      "receipt_unverified_source",
      `gate ${gated.gate}: comment ${comment.ref.comment_id} by ${comment.authorId ?? "an unknown author"} is a delegated verdict (delegated_verdict); the Gate stays waiting`,
      ["the Run's pod check records a delegated verdict"],
    );
  const bypass = readBypass(input.bypassPath, input.hostName);
  await recordBypass(db, run, input, bypass);
  const source = verifySource(
    comment,
    principalsOf(pinned?.policy),
    gated.keeper.keeper,
    bypass,
  );
  if (!source.ok)
    return unverified(gated.gate, comment.authorId, source.reason);
  const confirm = await tracker.readComment(comment.ref);
  if (
    !confirm.ok ||
    confirm.result === null ||
    hashOf(confirm.result.body, source.relayed_by) !== source.content_hash
  )
    return unverified(gated.gate, comment.authorId, "readback_differs");
  const readback_at = input.now();
  const deployed = await deployedRevision(db, run, gated.gate, comment);
  if ("ok" in deployed) return deployed;
  return {
    run,
    waiting: gated,
    comment,
    outcome: found.outcome,
    relayed_by: source.relayed_by,
    content_hash: source.content_hash,
    readback_at,
    deployed: deployed.revision,
    opKey: hqaOpKey(run, gated, comment, source.content_hash),
    actor: `person:${input.principal}`,
    verb: "hqa record",
    delegated: null,
  };
}

function hqaOpKey(
  run: Run,
  waiting: Waiting,
  comment: TrackerComment,
  content_hash: string,
): string {
  return derivedOpKey("hqa", {
    run_id: run.run_id,
    task_id: waiting.task.task_id,
    gate: waiting.gate,
    comment_id: comment.ref.comment_id,
    content_hash,
  });
}

export async function settleAccepted(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  accepted: Accepted,
  ctx: Settle,
): Promise<
  Checked<{
    receipt_id: number;
    op_key: string;
    outcome: OutcomeResult;
    nextSteps: string[];
  }>
> {
  const written = await db.transaction((tx) => write(tx, ctx, accepted));
  const nextSteps = await settleRuntime(
    { db, orca, log, now: ctx.now },
    accepted.run,
    accepted.waiting.task.task_id,
  );
  const followed = await followOutcome(db, orca, log, written.recorded, {
    task: accepted.waiting.task.task_id,
    outcome: accepted.outcome,
    at: ctx.now(),
    host: ctx.host,
    source: { kind: "receipt", receipt_id: written.receipt_id },
    command: ctx.command,
    now: ctx.now,
    version: ctx.version,
  });
  if (!followed.ok) return followed;
  return {
    ok: true,
    orca: ctx.version,
    result: {
      receipt_id: written.receipt_id,
      op_key: accepted.opKey,
      outcome: followed.result,
      nextSteps,
    },
  };
}

export async function recordHqa(
  db: Db,
  orca: OrcaPort,
  tracker: TrackerPort,
  log: ReceiptLog,
  input: HqaInput,
): Promise<Checked<HqaResult>> {
  const { version } = await orca.version();
  const story = await db.getStory(
    input.story.provider,
    input.story.external_id,
  );
  const run = story?.run_id == null ? null : await db.getRun(story.run_id);
  if (run === null)
    return refuse(
      "story_not_found",
      `no Run for story:${input.story.external_id}`,
      [`pod run create story:${input.story.external_id}`],
    );
  if (run.owner_generation !== input.generation)
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const result: HqaResult = {
    run_id: run.run_id,
    gate: null,
    receipt_id: null,
    op_key: null,
    outcome: null,
    nextSteps: [],
  };
  const accepted = await accept(db, tracker, run, input, result);
  if (accepted === null) return { ok: true, orca: version, result };
  if ("ok" in accepted) return accepted;
  const settled = await settleAccepted(db, orca, log, accepted, {
    generation: input.generation,
    host: input.host,
    command: input.command,
    now: input.now,
    version,
  });
  if (!settled.ok) return settled;
  const { nextSteps, ...recorded } = settled.result;
  return {
    ok: true,
    orca: version,
    result: {
      ...result,
      ...recorded,
      nextSteps: [...result.nextSteps, ...nextSteps],
    },
  };
}

const Cited = z.looseObject({ comment_id: z.string() });

export async function recordDelegatedHqa(
  db: Db,
  orca: OrcaPort,
  tracker: TrackerPort,
  log: ReceiptLog,
  run: Run,
  input: { generation: number; host: string; now: () => Date; version: string },
  story: () => Promise<StoryComments>,
): Promise<string[]> {
  const pinned = await pinnedConfig(db, run.run_id);
  const { waiting } = await waitingTasks(db, run, pinned?.policy);
  const [gated] = waiting;
  if (gated === undefined) return [];
  if (waiting.length > 1) {
    const { message } = new HqaAmbiguous(
      waiting.map((row) => ({ task: row.task.task_id, gate: row.gate })),
    );
    return [
      `${message}; a delegated verdict records one gate at a time, settle the other Task first`,
    ];
  }
  const { gate } = gated;
  const read = await story();
  if (!read.ok)
    return [
      `tracker readback of story:${run.story_external_id} failed: ${read.error}; a delegated HQA verdict waits for the next pod check`,
    ];
  const spent = new Set(
    (await db.listGateReceipts(run.run_id)).flatMap(
      (row) => Cited.safeParse(row.source).data?.comment_id ?? [],
    ),
  );
  const open = verdictComments(read.comments, gate).filter(
    (row) =>
      delegatedTrailer(row.comment.body) !== null &&
      !spent.has(row.comment.ref.comment_id),
  );
  const [found] = open;
  if (found === undefined) return [];
  if (open.length > 1) {
    const ids = open.map((row) => row.comment.ref.comment_id).join(", ");
    return [
      `gate ${gate} has more than one unrecorded delegated verdict comment: ${ids}; delete the ones that are not the verdict and run pod check again`,
    ];
  }
  const { comment } = found;
  const id = comment.ref.comment_id;
  const unverifiedLine = (reason: string) =>
    `receipt_unverified_source: gate ${gate} comment ${id} by ${comment.authorId ?? "an unknown author"} is not a verified delegated verdict (${reason}); the Gate stays waiting`;
  const global = await singleActive(db, "policy", "global", "");
  const readback_at = input.now();
  const checked = verifyDelegated(comment, {
    principals: principalsOf(global?.value),
    delegates: delegatesOf(global?.value),
    keeper: gated.keeper.keeper,
    readbackAt: readback_at,
  });
  if (checked === null) return [];
  if (!checked.ok) return [unverifiedLine(checked.reason)];
  const { delegate } = checked;
  const seats = (await db.listDispatches(run.run_id)).map((row) => row.seat);
  if (delegate === "coordinator" || seats.includes(delegate))
    return [
      `activation_needs_person: gate ${gate} comment ${id}: delegate ${delegate} is a Seat of Run ${run.run_id}; the Gate stays waiting`,
    ];
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const confirm = await tracker.readComment(comment.ref);
  if (
    !confirm.ok ||
    confirm.result === null ||
    contentHash(confirm.result.body) !== checked.content_hash
  )
    return [unverifiedLine("readback_differs")];
  const deployed = await deployedRevision(db, run, gate, comment);
  if ("ok" in deployed)
    return [
      `${deployed.refusal.code}: ${deployed.refusal.message}`,
      ...deployed.refusal.nextSteps,
    ];
  const settled = await settleAccepted(
    db,
    orca,
    log,
    {
      run,
      waiting: gated,
      comment,
      outcome: found.outcome,
      relayed_by: null,
      content_hash: checked.content_hash,
      readback_at,
      deployed: deployed.revision,
      opKey: hqaOpKey(run, gated, comment, checked.content_hash),
      actor: `delegate:${delegate}`,
      verb: "check",
      delegated: { delegate, keeper_quote: checked.keeper_quote },
    },
    { ...input, command: "pod check" },
  );
  if (!settled.ok)
    return [settled.refusal.message, ...settled.refusal.nextSteps];
  return [
    ...settled.result.nextSteps,
    `gate ${gate} receipt ${settled.result.receipt_id} recorded from delegate ${delegate}'s verdict comment ${id}`,
  ];
}

export interface VoidInput {
  run: string;
  generation: number;
  host: string;
  now: () => Date;
}

const settled: readonly TaskState[] = ["done", "failed"];
const holdable: readonly TaskState[] = ["delivered", "passed", "blocked"];

async function voidReceipt(
  tx: Repo,
  receipt: GateReceipt,
  input: VoidInput,
): Promise<boolean> {
  const run = await fence(tx, input.run, input.generation);
  const current = (await tx.listGateReceipts(run.run_id)).find(
    (row) => row.id === receipt.id,
  );
  if (current?.sync_state !== "synced") return false;
  await tx.setGateReceiptSync(receipt.id, "voided");
  const at = input.now();
  const hold = (task_id: string | null, payload: Json) =>
    tx.appendEvent({
      type: "hold",
      ts: at,
      host: input.host,
      run_id: run.run_id,
      task_id,
      dispatch_id: null,
      op_key: null,
      payload,
      source: { kind: "command", verb: "check" },
    });
  const reason = "receipt_voided";
  if (run.state === "active" || run.state === "drained") {
    await tx.setRunState(run.run_id, "hold");
    await hold(null, { reason, receipt_id: receipt.id, from: run.state });
  }
  const task = await tx.getTask(receipt.task_id);
  if (task === null) return true;
  if (holdable.includes(task.state)) {
    await moveTask(tx, task.task_id, "hold");
    await hold(task.task_id, {
      reason,
      receipt_id: receipt.id,
      from: task.state,
    });
  } else if (settled.includes(task.state))
    await hold(task.task_id, { reason, receipt_id: receipt.id, moved: false });
  return true;
}

export async function voidEditedReceipts(
  db: Db,
  tracker: TrackerPort,
  log: ReceiptLog,
  input: VoidInput,
): Promise<{ voided: number[]; nextSteps: string[] }> {
  const voided: number[] = [];
  const nextSteps: string[] = [];
  for (const receipt of await db.listGateReceipts(input.run)) {
    if (receipt.sync_state !== "synced") continue;
    const source = TrackerSource.safeParse(receipt.source);
    if (!source.success) continue;
    const { provider, issue, comment_id } = source.data;
    log.at({ run_id: input.run, task_id: receipt.task_id, op_key: null });
    const read = await tracker.readComment({
      provider,
      external_id: issue,
      comment_id,
    });
    if (!read.ok || read.result === null) {
      nextSteps.push(
        `tracker read of comment ${comment_id} for receipt ${receipt.id} failed: ${read.error ?? "not found"}; run pod check again`,
      );
      continue;
    }
    const { editedAt, body } = read.result;
    const edited =
      editedAt !== null &&
      new Date(editedAt).getTime() >
        new Date(source.data.readback_at).getTime();
    if (
      !edited &&
      hashOf(body, source.data.relayed_by) === source.data.content_hash
    )
      continue;
    if (await db.transaction((tx) => voidReceipt(tx, receipt, input))) {
      voided.push(receipt.id);
      nextSteps.push(
        `receipt ${receipt.id} on gate ${receipt.gate_id} is voided because its comment changed; the Run is on hold until pod check --resume`,
      );
    }
  }
  return { voided, nextSteps };
}
