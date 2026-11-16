import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { digestCap } from "../config/digest-cap.ts";
import { postDigest } from "../digest/post.ts";
import { acceptProposalFile, dayOf } from "../domain/digest.ts";
import { Json } from "../domain/json.ts";
import type { Db, Repo } from "../ports/db.ts";
import { activeProcesses } from "../process/active.ts";
import { ProcessValue } from "../process/schema.ts";
import type { MetaStep, MetaStepContext, MetaStepResult } from "./meta.ts";
import type {
  Packet,
  PacketContext,
  PacketItem,
  PacketInput,
} from "./packet.ts";
import { writeVerifiedOutput } from "./watermark.ts";

export const digestStep = "digest";

export const failWindowMs = 72 * 60 * 60 * 1000;

export interface MetaSeatRequest {
  step: "digest";
  role: string;
  method: string | null;
  scope: string;
  opKey: string;
  packet: string;
  signal: AbortSignal;
}

export type MetaSeatResult =
  { ok: true; file: string } | { ok: false; message: string };

export interface MetaSeat {
  built: boolean;
  run(request: MetaSeatRequest): Promise<MetaSeatResult>;
}

export const unbuiltSeat: MetaSeat = {
  built: false,
  run: () => Promise.resolve({ ok: false, message: "no meta Seat launch" }),
};

export interface Posted {
  scope: string;
  day: string;
  opKey: string;
  shown: number[];
}

export interface DigestDeps {
  seat: MetaSeat;
  readback?: (db: Db, posted: Posted) => Promise<boolean>;
}

export function projectOf(scope: string): string | null {
  return scope.startsWith("project:") ? scope.slice("project:".length) : null;
}

const LearningEvent = z.looseObject({ learning_id: z.int() });
const ReceiptEvent = z.looseObject({ receipt_id: z.int() });
const RuledEvent = z.looseObject({
  decision_id: z.string(),
  ruling: z.looseObject({ author: z.string(), verb: z.string() }),
});
const OutcomeText = z.looseObject({ text: z.string() });

export interface Escalation {
  decision_id: string;
  event_id: number;
  ts: Date;
  verb: string;
  author: string;
  reason: string | null;
  note: string | null;
}

async function inScope(
  repo: Repo,
  runId: string,
  project: string | null,
): Promise<boolean> {
  if (project === null) return true;
  return (await repo.getSnapshot(runId))?.project === project;
}

async function learningItems(
  repo: Repo,
  project: string | null,
): Promise<PacketItem[]> {
  const open = await repo.listOpenProposals(
    project === null ? "global" : `project:${project}`,
  );
  const claimed = new Set(
    open
      .filter((row) => row.shown_on === null)
      .flatMap((row) => row.learning_ids),
  );
  const fresh = new Map(
    (await repo.listLearnings({ adoption: "new", project }))
      .filter((row) => !claimed.has(row.id))
      .map((row) => [row.id, row]),
  );
  const items: PacketItem[] = [];
  for (const event of await repo.eventsWith("learning", {})) {
    const id = LearningEvent.safeParse(event.payload).data?.learning_id;
    const row = id === undefined ? undefined : fresh.get(id);
    if (row === undefined) continue;
    fresh.delete(row.id);
    items.push({
      event_id: event.id,
      ts: event.ts,
      kind: "evidence",
      text: `learning ${row.id} [${row.kind}/${row.area}] ${row.text}${row.expected === null ? "" : ` | expected: ${row.expected}`}`,
      subject: `learning:${row.id}`,
    });
  }
  return items;
}

async function receiptItems(
  repo: Repo,
  project: string | null,
  now: Date,
): Promise<PacketItem[]> {
  const receipts = await repo.failReceiptsSince(
    new Date(now.getTime() - failWindowMs),
    project,
  );
  const byId = new Map(receipts.map((row) => [row.id, row]));
  const items: PacketItem[] = [];
  for (const event of await repo.eventsWith("receipt", { outcome: "FAIL" })) {
    const id = ReceiptEvent.safeParse(event.payload).data?.receipt_id;
    const row = id === undefined ? undefined : byId.get(id);
    if (row === undefined) continue;
    byId.delete(row.id);
    items.push({
      event_id: event.id,
      ts: event.ts,
      kind: "exception",
      text: `FAIL receipt ${row.id} gate ${row.gate_id} run ${row.run_id} task ${row.task_id} at ${row.candidate_sha}`,
      subject: `receipt:${row.id}`,
    });
  }
  return items;
}

export async function ruledEscalations(
  repo: Repo,
  project: string | null,
  after: number,
): Promise<Escalation[]> {
  const rows: Escalation[] = [];
  for (const event of await repo.eventsWith("decision", { ruling: {} })) {
    if (event.id <= after) continue;
    const ruled = RuledEvent.safeParse(event.payload).data;
    if (ruled === undefined || "refused" in ruled) continue;
    const decision = await repo.getDecision(ruled.decision_id);
    if (decision === null || !(await inScope(repo, decision.run_id, project)))
      continue;
    rows.push({
      decision_id: decision.id,
      event_id: event.id,
      ts: event.ts,
      verb: ruled.ruling.verb,
      author: ruled.ruling.author,
      reason: decision.reason,
      note:
        ruled.ruling.verb === "agreed"
          ? (OutcomeText.safeParse(decision.outcome).data?.text ?? null)
          : null,
    });
  }
  return rows;
}

async function escalationItems(
  repo: Repo,
  project: string | null,
  after: number,
): Promise<PacketItem[]> {
  return (await ruledEscalations(repo, project, after)).map((row) => ({
    event_id: row.event_id,
    ts: row.ts,
    kind: "ruling",
    text: `decision ${row.decision_id} ${row.verb} by ${row.author}: reason ${row.reason ?? "none"}; note ${row.note ?? "none"}`,
    subject: `decision:${row.decision_id}`,
  }));
}

export const digestInput: PacketInput = async (repo, ctx: PacketContext) => {
  const project = projectOf(ctx.scope);
  return [
    ...(await learningItems(repo, project)),
    ...(await receiptItems(repo, project, ctx.now)),
    ...(await escalationItems(repo, project, ctx.watermark?.event_id ?? 0)),
  ];
};

export function renderPacket(
  packet: Packet,
  scope: string,
  cap: number,
  queued: readonly number[],
): string {
  return [
    `digest packet for ${scope}: ${packet.items.length} items, ${packet.words} words`,
    `cap ${cap} shown a day; queued proposals shown first: ${queued.length === 0 ? "none" : queued.map((n) => `#${n}`).join(", ")}`,
    ...packet.items.map(
      (item) => `- [${item.kind}] event ${item.event_id}: ${item.text}`,
    ),
    ...(packet.routing === null ? [] : [packet.routing]),
  ].join("\n");
}

function failed(code: string, message: string): MetaStepResult {
  return { result: "failed", detail: { code, message } };
}

const aborted = failed(
  "timed_out",
  "the step passed limits.packet_minutes; no output was written",
);

async function digestProcess(
  db: Db,
): Promise<{ role: string; method: string | null } | MetaStepResult> {
  const meta = (await activeProcesses(db)).filter(
    (row) => row.selector.stage === "meta",
  );
  const [only] = meta;
  if (only === undefined)
    return failed(
      "config_missing",
      "no active process Revision has selector stage meta",
    );
  if (meta.length > 1)
    return failed(
      "selector_many",
      `${meta.length} active process Revisions have selector stage meta`,
    );
  const revision = await db.getRevision(only.revisionId);
  const step = ProcessValue.safeParse(revision?.value).data?.steps.find(
    (row) => row.id === digestStep,
  );
  if (step?.role === undefined)
    return failed(
      "config_missing",
      `process ${only.name} has no ${digestStep} worker step`,
    );
  return { role: step.role, method: step.method ?? null };
}

function readProposals(path: string): unknown {
  const doc = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  const [first] = doc.errors;
  if (first !== undefined)
    throw new Error(`${path} is not valid YAML: ${first.message}`);
  return doc.toJS();
}

async function seatProposals(
  deps: DigestDeps,
  ctx: MetaStepContext,
  process: { role: string; method: string | null },
) {
  const queued = (await ctx.db.listOpenProposals(ctx.scope))
    .filter((row) => row.shown_on === null)
    .map((row) => row.id);
  const cap = await digestCap(ctx.db, projectOf(ctx.scope));
  if (ctx.signal.aborted) return aborted;
  const launched = await deps.seat.run({
    step: digestStep,
    role: process.role,
    method: process.method,
    scope: ctx.scope,
    opKey: ctx.opKey,
    packet: renderPacket(ctx.packet, ctx.scope, cap, queued),
    signal: ctx.signal,
  });
  if (!launched.ok) return failed("seat_failed", launched.message);
  let value: unknown;
  try {
    value = readProposals(launched.file);
  } catch (error) {
    return failed(
      "file_unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }
  const accepted = acceptProposalFile(value);
  if (!accepted.ok) return failed("schema_invalid", accepted.issues.join("; "));
  return accepted.proposals;
}

export async function readPosted(db: Db, posted: Posted): Promise<boolean> {
  const event = (
    await db.eventsWith("digest", { scope: posted.scope, day: posted.day })
  ).find((each) => each.op_key === posted.opKey);
  if (event === undefined) return false;
  const shown = new Set(
    (await db.listShownProposals(posted.scope, posted.day)).map(
      (row) => row.id,
    ),
  );
  return posted.shown.every((number) => shown.has(number));
}

async function runDigest(
  deps: DigestDeps,
  ctx: MetaStepContext,
): Promise<MetaStepResult> {
  const process = await digestProcess(ctx.db);
  if ("result" in process) return process;
  const proposals =
    ctx.packet.items.length === 0
      ? []
      : await seatProposals(deps, ctx, process);
  if (!Array.isArray(proposals)) return proposals;
  if (ctx.signal.aborted) return aborted;
  const outcome = await postDigest(ctx.db, {
    project: projectOf(ctx.scope),
    proposals,
    host: ctx.host,
    now: () => ctx.now,
  });
  if (!outcome.ok) return failed(outcome.refusal.code, outcome.refusal.message);
  const posted: Posted = {
    scope: outcome.scope,
    day: outcome.day,
    opKey: outcome.opKey,
    shown: outcome.shown.map((row) => row.number),
  };
  const summary = {
    day: outcome.day,
    shown: posted.shown,
    queued: outcome.queued,
    truncated: ctx.packet.truncated,
    routing: ctx.packet.routing,
  };
  const readback = () => (deps.readback ?? readPosted)(ctx.db, posted);
  const unread = failed(
    "readback_failed",
    `digest ${posted.opKey} did not read back`,
  );
  if (ctx.signal.aborted) return aborted;
  if (ctx.packet.bound === null)
    return (await readback())
      ? { result: "ok", detail: Json.parse({ ...summary, output_event: null }) }
      : unread;
  const written = await writeVerifiedOutput(ctx.db, {
    type: "digest",
    ts: ctx.now,
    host: ctx.writer,
    payload: {
      scope: ctx.scope,
      day: dayOf(ctx.now),
      posted: posted.opKey,
      packet: {
        items: ctx.packet.items.length,
        words: ctx.packet.words,
        truncated: ctx.packet.truncated,
        held: ctx.packet.held,
      },
    },
    source: Json.parse({ kind: "command", verb: "tick", agenda: "meta" }),
    ref: { step: digestStep, scope: ctx.scope, input: ctx.packet.bound },
    opKey: ctx.opKey,
    readback,
  });
  if (!written.written) return unread;
  return {
    result: "ok",
    detail: Json.parse({ ...summary, output_event: written.event_id }),
  };
}

export function digestMetaStep(deps: DigestDeps): MetaStep {
  return {
    name: digestStep,
    built: deps.seat.built,
    output: "digest",
    scope: () => "global",
    input: digestInput,
    run: (ctx) => runDigest(deps, ctx),
  };
}
