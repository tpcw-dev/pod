import { z } from "zod";
import { sha256Hex } from "../config/canonical-json.ts";
import { Json } from "../domain/json.ts";
import type {
  Dispatch,
  Event,
  OperationStatus,
  Run,
} from "../domain/ledger.ts";
import { refuse, type Outcome } from "../domain/outcome.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt, SendResult } from "../ports/orca.ts";
import { fence } from "./fence.ts";

const bodyLimit = 8000;

const nonAsking = ["decider", "auditor"];
const asking = ["escalation", "question"];

export type Transport = "reply" | "thread";

export interface Question {
  message_id: string;
  dispatch_id: string;
  task_id: string | null;
  type: string;
  subject: string | null;
  body: string | null;
  body_truncated: boolean;
  notice: boolean;
  folded: string[];
  unfinished: { op_key: string; status: OperationStatus } | null;
}

export interface ReplyInput {
  message: string;
  body: string;
  generation: number;
  host: string;
  now: () => Date;
}

export interface ReplyResult {
  message_id: string;
  dispatch_id: string;
  task_id: string | null;
  transport: Transport;
  content_hash: string;
  sent_message_id: string | null;
  replayed: boolean;
  answered_elsewhere: boolean;
  owner_generation: number;
}

const Waiting = z.looseObject({
  message_id: z.string(),
  type: z.string(),
  outcome: z.literal("waiting"),
  subject: z.string().nullish(),
  body: z.string().nullish(),
  body_truncated: z.boolean().optional(),
  notice: z.boolean().optional(),
});
type Waiting = z.infer<typeof Waiting>;

const Answered = z.looseObject({ question_id: z.string() });

const Pending = z.looseObject({
  message_id: z.string(),
  dispatch_id: z.string(),
  transport: z.enum(["reply", "thread"]),
  content_hash: z.string(),
});

const Done = Pending.extend({
  sent_message_id: z.string().nullable(),
  answered_elsewhere: z.boolean(),
});

const Sent = z.looseObject({
  message: z.looseObject({ id: z.string() }),
});

const ErrorCode = z.looseObject({
  error: z.looseObject({ code: z.string() }),
});

export function cut(text: string | null | undefined): {
  body: string | null;
  body_truncated: boolean;
} {
  if (text === null || text === undefined)
    return { body: null, body_truncated: false };
  return {
    body: text.slice(0, bodyLimit),
    body_truncated: text.length > bodyLimit,
  };
}

async function unfinishedReplies(
  db: Repo,
): Promise<Map<string, { op_key: string; status: OperationStatus }[]>> {
  const byMessage = new Map<
    string,
    { op_key: string; status: OperationStatus }[]
  >();
  for (const operation of await db.listOperations(
    ["reply"],
    ["pending", "unknown"],
  )) {
    const ref = Pending.safeParse(operation.result_ref);
    if (!ref.success) continue;
    const rows = byMessage.get(ref.data.message_id) ?? [];
    rows.push({ op_key: operation.op_key, status: operation.status });
    byMessage.set(ref.data.message_id, rows);
  }
  return byMessage;
}

async function answeredIds(db: Repo, runId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const event of await db.listEvents(runId, "reply")) {
    const parsed = Answered.safeParse(event.payload);
    if (parsed.success) ids.add(parsed.data.question_id);
  }
  return ids;
}

function waitingOf(event: Event): Waiting | null {
  const parsed = Waiting.safeParse(event.payload);
  return parsed.success ? parsed.data : null;
}

export async function openQuestions(db: Repo, run: Run): Promise<Question[]> {
  return questionsOn(
    db,
    run,
    (await db.listDispatches(run.run_id)).filter(
      (row) => row.settlement === "open",
    ),
  );
}

/** The one reader of the question rules: `pod check` and `pod reply` agree. */
export async function questionsOn(
  db: Repo,
  run: Run,
  dispatches: readonly Dispatch[],
): Promise<Question[]> {
  const open = new Set(
    dispatches
      .filter((row) => !nonAsking.includes(row.role))
      .map((row) => row.dispatch_id),
  );
  const answered = await answeredIds(db, run.run_id);
  const unfinished = await unfinishedReplies(db);
  const byDispatch = new Map<string, { event: Event; said: Waiting }[]>();
  for (const event of await db.listEvents(run.run_id, "delivery")) {
    if (event.dispatch_id === null || !open.has(event.dispatch_id)) continue;
    const said = waitingOf(event);
    if (said === null || !asking.includes(said.type)) continue;
    if (answered.has(said.message_id)) continue;
    const rows = byDispatch.get(event.dispatch_id) ?? [];
    rows.push({ event, said });
    byDispatch.set(event.dispatch_id, rows);
  }
  const questions: Question[] = [];
  for (const [dispatchId, rows] of byDispatch) {
    const [oldest] = rows;
    if (oldest === undefined) continue;
    const named = rows.find((row) => row.said.notice !== true) ?? oldest;
    questions.push({
      message_id: named.said.message_id,
      dispatch_id: dispatchId,
      task_id: named.event.task_id,
      type: named.said.type,
      subject: named.said.subject ?? null,
      body: named.said.body ?? null,
      body_truncated: named.said.body_truncated ?? false,
      notice: named.said.notice ?? false,
      folded: rows
        .filter((row) => row !== named)
        .map((row) => row.said.message_id),
      unfinished: unfinished.get(named.said.message_id)?.[0] ?? null,
    });
  }
  return questions;
}

export function questionLine(question: Question, generation: number): string {
  const id = question.message_id;
  const rerun = `pod reply --message ${id} --generation ${generation} FILE`;
  const folds =
    question.folded.length === 0 ? "" : `; folds ${question.folded.join(", ")}`;
  if (question.unfinished !== null)
    return `reply to ${id} on ${question.dispatch_id} is ${question.unfinished.status} (op ${question.unfinished.op_key}): rerun ${rerun} with the same FILE${folds}`;
  return `worker asks on ${question.dispatch_id} (${question.subject ?? "no subject"}): ${rerun}${folds}`;
}

function sentId(receipt: Receipt<SendResult>): string | null {
  return Sent.safeParse(receipt.result).data?.message.id ?? null;
}

function codeOf(receipt: Receipt<SendResult>): string | null {
  return ErrorCode.safeParse(receipt.raw).data?.error.code ?? null;
}

const landed = (receipt: Receipt<SendResult>) =>
  receipt.exitCode === 0 && receipt.result !== null;

export async function reply(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReplyInput,
): Promise<Outcome<ReplyResult>> {
  const id = input.message;
  const event = await db.eventWith("delivery", { message_id: id });
  if (event === null)
    return refuse("task_not_ready", `no recorded delivery for message ${id}`, [
      "pod brief",
    ]);
  const runId = event.run_id;
  const run = runId === null ? null : await db.getRun(runId);
  if (run === null || event.dispatch_id === null)
    return refuse(
      "task_not_ready",
      `message ${id} belongs to no Run Dispatch`,
      ["pod brief"],
    );
  if (run.owner_generation !== input.generation)
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );
  if (run.host !== input.host)
    return refuse(
      "wrong_host",
      `Run ${run.run_id} belongs to host ${run.host}, not ${input.host}`,
      [`pod reply on host ${run.host}`],
    );
  const check = `pod check --run ${run.run_id} --generation ${input.generation}`;
  const dispatch = await db.getDispatch(event.dispatch_id);
  if (dispatch === null)
    throw new Error(`Dispatch ${event.dispatch_id} vanished`);
  const said = waitingOf(event);
  if (said === null)
    return refuse("task_not_ready", `message ${id} is not a waiting delivery`, [
      check,
    ]);
  if (said.type === "decision_gate" || nonAsking.includes(dispatch.role))
    return refuse(
      "task_not_ready",
      `message ${id} belongs to a Decision; answer it with pod decide`,
      [check],
    );
  if (dispatch.settlement !== "open")
    return refuse(
      "task_not_ready",
      `Dispatch ${dispatch.dispatch_id} is settled ${dispatch.settlement}; nothing waits for an answer`,
      [check],
    );

  const contentHash = sha256Hex(input.body);
  const opKey = derivedOpKey("reply", {
    message_id: id,
    content_hash: contentHash,
  });
  const { version } = await orca.version();
  const result = (
    stored: z.infer<typeof Done>,
    replayed: boolean,
  ): ReplyResult => ({
    message_id: id,
    dispatch_id: dispatch.dispatch_id,
    task_id: dispatch.task_id,
    transport: stored.transport,
    content_hash: contentHash,
    sent_message_id: stored.sent_message_id,
    replayed,
    answered_elsewhere: stored.answered_elsewhere,
    owner_generation: input.generation,
  });

  const existing = await db.getOperation(opKey);
  if (existing?.status === "done") {
    const stored = Done.parse(existing.result_ref);
    return { ok: true, result: result(stored, true), opKey, orca: version };
  }
  const other = (await unfinishedReplies(db))
    .get(id)
    ?.find((row) => row.op_key !== opKey);
  if (other !== undefined)
    return refuse(
      "task_not_ready",
      `reply ${other.op_key} on message ${id} is ${other.status}; rerun pod reply with the text of that answer`,
      [check],
    );

  const answered = (await answeredIds(db, run.run_id)).has(id);
  const transport: Transport =
    said.notice === true || answered ? "thread" : "reply";
  const ref = {
    message_id: id,
    dispatch_id: dispatch.dispatch_id,
    transport,
    content_hash: contentHash,
  };
  const operation = await db.transaction(async (tx) => {
    await fence(tx, run.run_id, input.generation);
    return (
      await tx.insertOperation({
        op_key: opKey,
        intent: "reply",
        owner_generation: input.generation,
        at: input.now(),
        result_ref: ref,
      })
    ).operation;
  });

  log.at({ run_id: run.run_id, task_id: dispatch.task_id, op_key: opKey });
  const send = (threaded: boolean) =>
    orca.send({
      to: `dispatch:${dispatch.dispatch_id}`,
      subject: `Re: ${said.subject ?? id}`,
      body: input.body,
      ...(threaded ? { threadId: id } : {}),
      from: run.coordinator,
    });
  let receipt =
    transport === "reply"
      ? await orca.reply({ id, body: input.body, from: run.coordinator })
      : await send(answered);
  let sentBy = transport;
  let elsewhere = false;
  if (transport === "reply" && codeOf(receipt) === "answer_conflict") {
    receipt = await send(true);
    sentBy = "thread";
    elsewhere = true;
  }

  const at = input.now();
  if (landed(receipt)) {
    const stored = {
      ...ref,
      transport: sentBy,
      sent_message_id: sentId(receipt),
      answered_elsewhere: elsewhere,
    };
    await db.transaction(async (tx) => {
      await fence(tx, run.run_id, input.generation);
      await tx.moveOperation(opKey, "done", Json.parse(stored), at);
      await tx.appendEvent({
        type: "reply",
        ts: at,
        host: input.host,
        run_id: run.run_id,
        task_id: dispatch.task_id,
        dispatch_id: dispatch.dispatch_id,
        op_key: opKey,
        payload: Json.parse({
          question_id: id,
          transport: sentBy,
          content_hash: contentHash,
          ...cut(input.body),
          sent_message_id: stored.sent_message_id,
          answered_elsewhere: elsewhere,
        }),
        source: { kind: "command", verb: "reply" },
      });
      await tx.setDispatchActivity(dispatch.dispatch_id, "running", at);
    });
    return { ok: true, result: result(stored, false), opKey, orca: version };
  }
  const code = codeOf(receipt);
  if (operation.status === "pending")
    await db.moveOperation(
      opKey,
      "unknown",
      Json.parse({ ...ref, exit_code: receipt.exitCode, code }),
      at,
    );
  return refuse(
    "failed",
    `reply to ${id} answered ${code ?? `exit ${receipt.exitCode}`}`,
    [`pod reply --message ${id} --generation ${input.generation} FILE`],
  );
}
