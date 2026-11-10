import { z } from "zod";
import {
  BranchOutcome,
  CloseStepName,
  KeepFilesReviewed,
  P0Kind,
  PlannedWorktree,
  WorktreeOutcome,
  type CloseReport,
  type ReviewedWorktree,
  type CloseResult,
  type WorktreeStatus,
} from "../domain/close.ts";
import { storyStatusOf } from "../config/policy.ts";
import type { Snapshot } from "../domain/config.ts";
import { openStates } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import {
  OutboxPayload,
  type Dispatch,
  type Event,
  type GateReceipt,
  type Run,
  type Story,
} from "../domain/ledger.ts";
import { refuse, type Refusal, type Refused } from "../domain/outcome.ts";
import { dispatchWorktree } from "../dispatch/retry.ts";
import { gateOf } from "../gate/receipt.ts";
import { writeLearning } from "../learning/add.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { recordRunManifest } from "../manifest/run-manifest.ts";
import type { CodeHostPort } from "../ports/code-host.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { GitPort } from "../ports/git.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  canceledByHuman,
  statusUnknown,
  type TrackerPort,
} from "../ports/tracker.ts";
import {
  commentPayload,
  drainOutbox,
  OUTBOX_MAX_TRIES,
} from "../tracker/outbox.ts";
import {
  branchesRemovedField,
  keptLines,
  openPrRefusal,
  planWorktrees,
  readPrs,
  remoteKeptField,
  removeBranches,
  removeWorktrees,
  worktreeField,
} from "./close-effects.ts";
import { coordinatorStopped } from "./takeover.ts";

export interface CloseInput {
  story: string;
  provider: string;
  generation: number;
  report: CloseReport;
  reportHash: string;
  keepFilesReviewed: boolean;
  host: string;
  worktreeStatus: (path: string) => WorktreeStatus | null;
  now: () => Date;
  tracker: TrackerPort | null;
  codeHost: CodeHostPort;
  git: GitPort;
  actor: string;
}

export type Closed = { ok: true; result: CloseResult; opKey: string } | Refused;

export function closeStepKey(runId: string, step: CloseStepName): string {
  return derivedOpKey("close", { run: runId, step });
}

export function composerText(tail: readonly string[]): string {
  for (const line of [...tail].reverse()) {
    const row = line.trimStart();
    const marker = /^(?:│\s*)?❯|^›/.exec(row);
    if (marker === null) continue;
    return row.slice(marker[0].length).replace(/│\s*$/, "").trim();
  }
  return "";
}

interface Archive {
  op_key: string;
  snapshot_hash: string;
  report_hash: string;
  report: CloseResult["report"];
  dispatches: Json[];
  seats: Json[];
  pr_events: number[];
  keep_files_reviewed: KeepFilesReviewed | null;
  gone: string[];
  worktrees: PlannedWorktree[];
  retro_due: boolean;
  actor: string;
}

interface Context {
  db: Db;
  run: Run;
  input: CloseInput;
  orca: OrcaPort;
  dispatches: Dispatch[];
  tracker: TrackerPort;
  log: ReceiptLog;
  archive: Archive;
  snapshot: Snapshot;
  status: string | null;
}

class StepRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

interface LedgerStep {
  name: CloseStepName;
  act(tx: Repo, ctx: Context): Promise<Json>;
  readBack(db: Repo, ctx: Context): Promise<Json | null>;
}

interface TrackerStep {
  name: CloseStepName;
  payload(tx: Repo, ctx: Context): Promise<OutboxPayload | null>;
}

interface EffectStep {
  name: CloseStepName;
  effect(ctx: Context, partial: Json | null, save: Save): Promise<Json>;
}

type Save = (fields: { [key: string]: Json }) => Promise<void>;

type CloseStep = LedgerStep | TrackerStep | EffectStep;

const sizesWithRetro: readonly string[] = ["m", "l", "xl"];

function storyRef(run: Run) {
  return { provider: run.story_provider, external_id: run.story_external_id };
}

function closeSource(): Json {
  return { kind: "command", verb: "run close" };
}

function leftoverLearnings(report: CloseInput["report"]) {
  return report.leftovers.filter((row) => row.p0 === undefined);
}

function p0Leftovers(report: CloseInput["report"]) {
  return report.leftovers.flatMap((row) =>
    row.p0 === undefined ? [] : [{ kind: row.p0, text: row.text }],
  );
}

const LearningsResult = z.looseObject({
  result: z.looseObject({ learning_ids: z.array(z.int()) }),
});

async function learningIds(db: Repo, runId: string): Promise<number[]> {
  const row = await db.getOperation(closeStepKey(runId, "learnings"));
  return (
    LearningsResult.safeParse(row?.result_ref).data?.result.learning_ids ?? []
  );
}

const EscalateEvent = z.looseObject({ kind: P0Kind, text: z.string() });

async function escalations(db: Repo, runId: string) {
  const key = closeStepKey(runId, "escalate");
  return (await db.listEvents(runId, "escalate")).flatMap((event) => {
    if (event.op_key !== key) return [];
    const parsed = EscalateEvent.safeParse(event.payload);
    return parsed.success
      ? [{ kind: parsed.data.kind, text: parsed.data.text }]
      : [];
  });
}

const WorktreeStepResult = z.looseObject({
  result: z.looseObject({ worktrees: z.array(WorktreeOutcome) }),
});

const BranchesStepResult = z.looseObject({
  result: z.looseObject({ branches: z.array(BranchOutcome) }),
});

const BranchesPartial = z.looseObject({
  partial: z.array(BranchOutcome),
});

async function worktreeOutcomes(db: Repo, runId: string) {
  const row = await db.getOperation(closeStepKey(runId, "worktree"));
  return (
    WorktreeStepResult.safeParse(row?.result_ref).data?.result.worktrees ?? []
  );
}

async function branchOutcomes(db: Repo, runId: string) {
  const row = await db.getOperation(closeStepKey(runId, "branches"));
  return (
    BranchesStepResult.safeParse(row?.result_ref).data?.result.branches ?? []
  );
}

async function archivedRecord(db: Repo, runId: string) {
  const archived = await db.eventWith("close", {
    op_key: closeStepKey(runId, "archive"),
  });
  return ArchiveRecord.parse(archived?.payload ?? {});
}

function againCommand(input: CloseInput): string {
  return `pod run close story:${input.story} --generation ${input.generation} with the same FILE`;
}

function commentBody(
  actor: string,
  runId: string,
  ids: readonly number[],
  p0: readonly { kind: string; text: string }[],
  retroDue: boolean,
  worktrees: readonly WorktreeOutcome[],
  branches: readonly BranchOutcome[],
): string {
  return [
    `${actor}: closed Run ${runId}`,
    "",
    `Worktree: ${worktreeField(worktrees)}`,
    `Branches removed: ${branchesRemovedField(branches)}`,
    `Remote branches kept: ${remoteKeptField(branches)}`,
    `Learnings: ${ids.length === 0 ? "none" : ids.join(", ")}`,
    `p0: ${p0.length === 0 ? "none" : p0.map((row) => `${row.kind}: ${row.text}`).join("; ")}`,
    `Retro due: ${retroDue ? "yes" : "no"}`,
  ].join("\n");
}

const closeSteps: readonly CloseStep[] = [
  {
    name: "archive",
    async act(tx, { run, input, archive }) {
      const payload = Json.parse(archive);
      await tx.appendEvent({
        type: "close",
        ts: input.now(),
        host: input.host,
        run_id: run.run_id,
        task_id: null,
        dispatch_id: null,
        op_key: archive.op_key,
        payload,
        source: closeSource(),
      });
      return payload;
    },
    async readBack(db, { archive }) {
      return (
        (await db.eventWith("close", { op_key: archive.op_key }))?.payload ??
        null
      );
    },
  },
  {
    name: "learnings",
    async act(tx, { run, input, snapshot }) {
      const entries = [
        ...input.report.learnings,
        ...leftoverLearnings(input.report).map((row) => ({
          text: row.text,
          area: row.area,
          evidence_refs: [] as string[],
        })),
      ];
      let manifest: string | null = null;
      const ids: number[] = [];
      for (const entry of entries) {
        if (entry.evidence_refs.length === 0 && manifest === null)
          manifest = (await recordRunManifest(tx, run, input.now())).id;
        const added = await writeLearning(tx, {
          row: {
            source_story: run.story_external_id,
            evidence_refs:
              entry.evidence_refs.length > 0
                ? entry.evidence_refs
                : [manifest ?? ""],
            text: entry.text,
            adoption: "new",
            area: entry.area,
            project_id: snapshot.project,
          },
          host: input.host,
          now: input.now,
          run_id: run.run_id,
          verb: "run close",
        });
        if (!added.ok) throw new StepRefused(added.refusal);
        ids.push(added.id);
      }
      return { learning_ids: ids };
    },
    async readBack() {
      return null;
    },
  },
  {
    name: "escalate",
    async act(tx, { run, input }) {
      const opKey = closeStepKey(run.run_id, "escalate");
      const p0 = p0Leftovers(input.report);
      for (const row of p0)
        await tx.appendEvent({
          type: "escalate",
          ts: input.now(),
          host: input.host,
          run_id: run.run_id,
          task_id: null,
          dispatch_id: null,
          op_key: opKey,
          payload: {
            story: run.story_external_id,
            kind: row.kind,
            text: row.text,
            actor: input.actor,
          },
          source: closeSource(),
        });
      return { escalations: p0.length };
    },
    async readBack(db, { run, input }) {
      const found = await escalations(db, run.run_id);
      return found.length === p0Leftovers(input.report).length
        ? { escalations: found.length }
        : null;
    },
  },
  {
    name: "worktree",
    async effect({ db, run, input, orca }) {
      const record = await archivedRecord(db, run.run_id);
      const reviewed = new Set(
        record.keep_files_reviewed?.worktrees.map((row) => row.path) ?? [],
      );
      const removed = await removeWorktrees(
        orca,
        record.worktrees,
        reviewed,
        againCommand(input),
      );
      if (!Array.isArray(removed)) throw new StepRefused(removed);
      return { worktrees: removed };
    },
  },
  {
    name: "branches",
    async effect({ db, run, input, dispatches }, partial, save) {
      const record = await archivedRecord(db, run.run_id);
      const reads = await readPrs(
        await db.listEvents(run.run_id, "pr"),
        dispatches,
        record.worktrees,
        input.codeHost,
      );
      const branches = await removeBranches(
        input.git,
        input.codeHost,
        record.worktrees,
        reads,
        BranchesPartial.safeParse(partial).data?.partial ?? [],
        (outcomes) => save({ partial: Json.parse(outcomes) }),
      );
      return { branches };
    },
  },
  {
    name: "status",
    async payload(_tx, { run, status }) {
      return status === null
        ? null
        : { kind: "status", story: storyRef(run), status };
    },
  },
  {
    name: "comment",
    async payload(tx, { run, input, archive }) {
      const body = commentBody(
        input.actor,
        run.run_id,
        await learningIds(tx, run.run_id),
        await escalations(tx, run.run_id),
        archive.retro_due,
        await worktreeOutcomes(tx, run.run_id),
        await branchOutcomes(tx, run.run_id),
      );
      return commentPayload(storyRef(run), body);
    },
  },
  {
    name: "done",
    async act(tx, { run }) {
      await tx.setRunState(run.run_id, "done");
      return { state: "done" };
    },
    async readBack(db, { run }) {
      return (await db.getRun(run.run_id))?.state === "done"
        ? { state: "done" }
        : null;
    },
  },
];

const finishedTasks: readonly string[] = ["done", "superseded", "failed"];
const heldDecisions: readonly string[] = [
  ...openStates,
  "needs_human",
  "reserved_needs_human",
];

async function owedWork(
  db: Repo,
  run: Run,
  dispatches: readonly Dispatch[],
  story: string,
): Promise<Refusal | null> {
  const owed = [
    ...(await db.listTasks(run.run_id))
      .filter((task) => !finishedTasks.includes(task.state))
      .map((task) => `Task ${task.task_id} is ${task.state}`),
    ...dispatches
      .filter(
        (row) =>
          row.activity === "running" &&
          row.dispatch_id !== run.coordinator_dispatch_id,
      )
      .map((row) => `Dispatch ${row.dispatch_id} is running`),
    ...(await db.listRunDecisions(run.run_id))
      .filter((decision) => heldDecisions.includes(decision.state))
      .map((decision) => `Decision ${decision.id} is ${decision.state}`),
  ];
  if (owed.length === 0) return null;
  return {
    code: "owed_work",
    message: `Run ${run.run_id} still owes ${owed.length} item(s) of work`,
    nextSteps: [...owed, `pod state story:${story}`],
  };
}

function question(
  dispatchId: string,
  handle: string,
  text: string | null,
): Refusal {
  return {
    code: "unanswered_question",
    message:
      text === null
        ? `the composer of Dispatch ${dispatchId}'s terminal ${handle} could not be read, so it is not known to be empty`
        : `Dispatch ${dispatchId}'s terminal ${handle} has text in its composer: ${text}`,
    nextSteps: [
      `orca terminal read --terminal ${handle} --screen`,
      "answer or clear the composer",
      "run the close again",
    ],
  };
}

async function unansweredQuestion(
  orca: OrcaPort,
  run: Run,
  dispatches: readonly Dispatch[],
): Promise<Refusal | null> {
  for (const row of dispatches) {
    const handle = row.terminal_handle;
    if (handle === null || row.dispatch_id === run.coordinator_dispatch_id)
      continue;
    if (coordinatorStopped(await orca.terminalShow({ terminal: handle })))
      continue;
    const receipt = await orca.terminalRead({ terminal: handle });
    const terminal = receipt.exitCode === 0 ? receipt.result?.terminal : null;
    if (terminal?.source !== "screen")
      return question(row.dispatch_id, handle, null);
    const text = composerText(terminal.tail);
    if (text !== "") return question(row.dispatch_id, handle, text);
  }
  return null;
}

async function worktreePaths(
  db: Repo,
  dispatches: readonly Dispatch[],
  host: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const row of dispatches) {
    const path = dispatchWorktree(row);
    if (path === null || paths.includes(path)) continue;
    if ((await db.dispatchEvent(row.dispatch_id, "start"))?.host !== host)
      continue;
    paths.push(path);
  }
  return paths;
}

function filesRefusal(
  flagged: readonly ReviewedWorktree[],
  story: string,
  generation: number,
): Refusal {
  return {
    code: "needs_file",
    message: `unreviewed work in ${flagged.map((row) => row.path).join(", ")}`,
    nextSteps: [
      ...flagged.flatMap((row) => [
        ...row.files.map((file) => `${row.path}: ${file}`),
        ...(row.ahead > 0
          ? [`${row.path}: branch ahead of its upstream by ${row.ahead}`]
          : []),
      ]),
      `pod run close story:${story} --generation ${generation} --keep-files-reviewed after a person reviewed the files`,
    ],
  };
}

function seatsOf(dispatches: readonly Dispatch[]): Json[] {
  const latest = new Map<string, Dispatch>();
  for (const row of dispatches) {
    const seen = latest.get(row.seat);
    if (seen === undefined || seen.created_at <= row.created_at)
      latest.set(row.seat, row);
  }
  return [...latest.values()].map((row) => ({
    seat: row.seat,
    role: row.role,
    dispatch_id: row.dispatch_id,
    activity: row.activity,
    settlement: row.settlement,
    settled_at: row.settled_at?.toISOString() ?? null,
  }));
}

function prEvents(events: readonly Event[]): CloseResult["pr_events"] {
  return events.map((event) => ({
    id: event.id,
    ts: event.ts.toISOString(),
    payload: event.payload,
  }));
}

const Recorded = z.looseObject({
  request: z.looseObject({ report_hash: z.string() }),
});

const ArchiveRecord = z.looseObject({
  report_hash: z.string().catch(""),
  report: z
    .object({ learnings: z.int(), leftovers: z.int(), decisions: z.int() })
    .catch({ learnings: 0, leftovers: 0, decisions: 0 }),
  keep_files_reviewed: KeepFilesReviewed.nullable().catch(null),
  gone: z.array(z.string()).catch([]),
  worktrees: z.array(PlannedWorktree).catch([]),
  retro_due: z.boolean().catch(false),
});

const Unapplied = z.looseObject({
  result: z.looseObject({ unapplied: z.string() }),
});

async function closedResult(
  db: Repo,
  run: Run,
  story: string,
  steps: CloseResult["steps"],
  alreadyClosed: boolean,
): Promise<Closed> {
  const archived = await db.eventWith("close", {
    op_key: closeStepKey(run.run_id, "archive"),
  });
  const record = ArchiveRecord.parse(archived?.payload ?? {});
  const branches = await branchOutcomes(db, run.run_id);
  const unapplied = Unapplied.safeParse(
    (await db.getOperation(closeStepKey(run.run_id, "status")))?.result_ref,
  ).data?.result.unapplied;
  return {
    ok: true,
    opKey: closeStepKey(run.run_id, "done"),
    result: {
      run_id: run.run_id,
      story,
      state: "done",
      owner_generation: run.owner_generation,
      report_hash: record.report_hash,
      report: record.report,
      steps,
      pr_events: prEvents(await db.listEvents(run.run_id, "pr")),
      keep_files_reviewed: record.keep_files_reviewed,
      gone: record.gone,
      retro_due: record.retro_due,
      learning_ids: await learningIds(db, run.run_id),
      escalations: await escalations(db, run.run_id),
      worktrees: await worktreeOutcomes(db, run.run_id),
      branches,
      already_closed: alreadyClosed,
      nextSteps: [
        ...(record.retro_due ? ["retro: required"] : []),
        ...keptLines(branches),
        ...(unapplied === undefined
          ? []
          : [
              `story:${story}: the tracker has no status ${unapplied}; set it by hand`,
            ]),
      ],
    },
  };
}

function staleRefusal(run: Run, generation: number): Refusal {
  return {
    code: "owner_generation_stale",
    message: `--generation ${generation} differs from the Run's owner generation ${run.owner_generation}`,
    nextSteps: [
      `pod takeover story:${run.story_external_id} if this session should own the Run`,
    ],
  };
}

const StoryAck = z.looseObject({
  story: z.looseObject({ status: z.string().nullable() }).nullable().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
});

type Stepped = { replayed: boolean } | Refused;

function ackResult(readback: Json): Json {
  const ack = StoryAck.safeParse(readback).data;
  return ack?.error === statusUnknown && ack.status !== undefined
    ? { unapplied: ack.status }
    : readback;
}

async function confirmTracker(
  name: CloseStepName,
  ctx: Context,
  request: Json,
): Promise<Stepped | null> {
  const { db, run, input } = ctx;
  const opKey = closeStepKey(run.run_id, name);
  const row = await db.outboxByOpKey(opKey);
  if (row === null) return null;
  const story = `story:${run.story_external_id}`;
  if (row.acked_at !== null) {
    const ack = StoryAck.safeParse(row.readback).data;
    if (ack?.error === canceledByHuman)
      return refuse(
        "story_canceled",
        `${story} is ${ack.story?.status ?? "Canceled"} in the tracker; the Run is on hold`,
        [`pod state ${story}`],
      );
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ request, result: ackResult(row.readback ?? null) }),
      input.now(),
    );
    return { replayed: false };
  }
  const payload = OutboxPayload.safeParse(row.payload).data;
  if (row.last_error === statusUnknown && payload?.kind === "status") {
    const readback = { error: statusUnknown, status: payload.status };
    await db.transaction(async (tx) => {
      await tx.ackOutbox(row.id, readback);
      await tx.moveOperation(
        opKey,
        "done",
        Json.parse({ request, result: ackResult(readback) }),
        input.now(),
      );
    });
    return { replayed: false };
  }
  const parked = row.tries >= OUTBOX_MAX_TRIES;
  return refuse(
    "tracker_unconfirmed",
    `the tracker has not confirmed outbox row ${row.id} of the close step ${name}: ${row.last_error ?? "not drained yet"}`,
    [
      ...(parked
        ? [
            `tracker outbox row ${row.id} parked after ${row.tries} tries: ${row.last_error ?? "no error recorded"}; fix the cause, then reset its tries`,
          ]
        : []),
      `pod run close ${story} --generation ${input.generation} with the same FILE`,
    ],
  );
}

function unconfirmed(stepped: Stepped): boolean {
  return "ok" in stepped && stepped.refusal.code === "tracker_unconfirmed";
}

function isTracker(step: CloseStep): step is TrackerStep {
  return "payload" in step;
}

function isEffect(step: CloseStep): step is EffectStep {
  return "effect" in step;
}

async function lockedOwner(
  tx: Repo,
  run: Run,
  generation: number,
): Promise<Refused | null> {
  const current = await tx.lockRun(run.run_id);
  if (current === null) throw new Error(`Run ${run.run_id} vanished`);
  return current.owner_generation === generation
    ? null
    : { ok: false, refusal: staleRefusal(current, generation) };
}

async function runEffect(
  step: EffectStep,
  ctx: Context,
  request: Json,
  existing: Json | null,
  created: boolean,
): Promise<Stepped> {
  const { db, run, input } = ctx;
  const opKey = closeStepKey(run.run_id, step.name);
  const started = await db.transaction(async (tx) => {
    const stale = await lockedOwner(tx, run, input.generation);
    if (stale !== null) return stale;
    if (!created)
      await tx.insertOperation({
        op_key: opKey,
        intent: "close",
        owner_generation: input.generation,
        at: input.now(),
        result_ref: Json.parse({ request }),
      });
    return null;
  });
  if (started !== null) return started;
  const save: Save = async (fields) => {
    const stale = await db.transaction(async (tx) => {
      const refused = await lockedOwner(tx, run, input.generation);
      if (refused === null)
        await tx.moveOperation(
          opKey,
          "pending",
          Json.parse({ request, ...fields }),
          input.now(),
        );
      return refused;
    });
    if (stale !== null) throw new StepRefused(stale.refusal);
  };
  let result: Json;
  try {
    result = await step.effect(ctx, existing, save);
  } catch (error) {
    if (error instanceof StepRefused)
      return { ok: false, refusal: error.refusal };
    throw error;
  }
  return db.transaction(async (tx) => {
    const stale = await lockedOwner(tx, run, input.generation);
    if (stale !== null) return stale;
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, result }),
      input.now(),
    );
    return { replayed: false };
  });
}

async function runStep(step: CloseStep, ctx: Context): Promise<Stepped> {
  const { db, run, input } = ctx;
  const opKey = closeStepKey(run.run_id, step.name);
  const request = {
    run_id: run.run_id,
    step: step.name,
    report_hash: input.reportHash,
  };
  const row = await db.getOperation(opKey);
  if (row?.status === "done") return { replayed: true };
  if (row?.status === "refused")
    throw new Error(`close step ${opKey} is refused`);
  if (isEffect(step))
    return runEffect(step, ctx, request, row?.result_ref ?? null, row !== null);
  if (row !== null) {
    if (isTracker(step)) {
      const confirmed = await confirmTracker(step.name, ctx, request);
      if (confirmed !== null && !unconfirmed(confirmed)) return confirmed;
    } else if (!isEffect(step)) {
      const back = await step.readBack(db, ctx);
      if (back !== null) {
        await db.moveOperation(
          opKey,
          "done",
          Json.parse({ request, result: back }),
          input.now(),
        );
        return { replayed: true };
      }
    }
  }
  let written: Stepped | "drain";
  try {
    written = await db.transaction(async (tx): Promise<Stepped | "drain"> => {
      const current = await tx.lockRun(run.run_id);
      if (current === null) throw new Error(`Run ${run.run_id} vanished`);
      if (current.owner_generation !== input.generation)
        return { ok: false, refusal: staleRefusal(current, input.generation) };
      const at = input.now();
      if (row === null)
        await tx.insertOperation({
          op_key: opKey,
          intent: "close",
          owner_generation: input.generation,
          at,
          result_ref: Json.parse({ request }),
        });
      if (!isTracker(step)) {
        const result = await step.act(tx, ctx);
        await tx.moveOperation(
          opKey,
          "done",
          Json.parse({ request, result }),
          at,
        );
        return { replayed: false };
      }
      if ((await tx.outboxByOpKey(opKey)) !== null) return "drain";
      const payload = await step.payload(tx, ctx);
      if (payload === null) {
        await tx.moveOperation(
          opKey,
          "done",
          Json.parse({ request, result: { status: null } }),
          at,
        );
        return { replayed: false };
      }
      await tx.enqueueOutbox({ op_key: opKey, target: "tracker", payload });
      return "drain";
    });
  } catch (error) {
    if (error instanceof StepRefused)
      return { ok: false, refusal: error.refusal };
    throw error;
  }
  if (written !== "drain") return written;
  await drainOutbox(db, ctx.tracker, ctx.log, {
    run_id: run.run_id,
    generation: input.generation,
    host: input.host,
    now: input.now,
  });
  const confirmed = await confirmTracker(step.name, ctx, request);
  if (confirmed === null)
    throw new Error(`close step ${opKey} lost its outbox row`);
  return confirmed;
}

function stepRows(
  runId: string,
  replayed: ReadonlySet<CloseStepName>,
): CloseResult["steps"] {
  return closeSteps.map((step) => ({
    step: step.name,
    op_key: closeStepKey(runId, step.name),
    status: "done",
    replayed: replayed.has(step.name),
  }));
}

function humanGatePending(
  policy: unknown,
  process: unknown,
  profile: string | null,
  receipts: readonly GateReceipt[],
): boolean {
  const steps = ProcessSteps.safeParse(process).data?.steps ?? [];
  const replaced =
    Replaces.safeParse(policy).data?.profiles?.[profile ?? ""]?.replaces;
  for (const { gate } of steps) {
    if (gate === undefined || gateOf(policy, gate)?.type !== "HQA") continue;
    if (replaced !== undefined && gate in replaced) continue;
    const latest = receipts
      .filter((row) => row.gate_id === gate && row.sync_state !== "voided")
      .sort((a, b) => a.id - b.id)
      .at(-1);
    if (latest?.outcome !== "PASS") return true;
  }
  return false;
}

const ProcessSteps = z.looseObject({
  steps: z.array(z.looseObject({ gate: z.string().optional() })),
});

const Replaces = z.looseObject({
  profiles: z
    .record(
      z.string(),
      z.looseObject({ replaces: z.record(z.string(), z.unknown()).optional() }),
    )
    .optional(),
});

async function pinned(db: Repo, run: Run) {
  const snapshot = await db.getSnapshot(run.run_id);
  if (snapshot === null) throw new Error(`Run ${run.run_id} lost its Snapshot`);
  const policy = await db.getRevision(snapshot.policy_revision_id);
  const process = await db.getRevision(snapshot.process_revision_id);
  if (policy === null || process === null)
    throw new Error(`Run ${run.run_id} lost a pinned Revision`);
  return { snapshot, policy: policy.value, process: process.value };
}

function retroDue(story: Story, receipts: readonly GateReceipt[]): boolean {
  return (
    sizesWithRetro.includes(story.size) ||
    receipts.some((row) => row.outcome === "FAIL")
  );
}

const noTracker: Refusal = {
  code: "tracker_unconfirmed",
  message:
    "the close posts its closing comment and the Story status through the tracker, and this host has no tracker",
  nextSteps: ["set the tracker token in the host profile, then close again"],
};

export async function closeRun(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: CloseInput,
): Promise<Closed> {
  const story = await db.getStory(input.provider, input.story);
  const run = story?.run_id == null ? null : await db.getRun(story.run_id);
  if (story === null || run === null)
    return refuse("story_not_found", `no Run for story:${input.story}`, [
      "pod brief",
    ]);
  if (run.state === "done")
    return closedResult(
      db,
      run,
      input.story,
      stepRows(run.run_id, new Set(CloseStepName.options)),
      true,
    );
  if (input.generation !== run.owner_generation)
    return { ok: false, refusal: staleRefusal(run, input.generation) };

  const dispatches = await db.listDispatches(run.run_id);
  const owed = await owedWork(db, run, dispatches, input.story);
  if (owed !== null) return { ok: false, refusal: owed };
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const asked = await unansweredQuestion(orca, run, dispatches);
  if (asked !== null) return { ok: false, refusal: asked };

  const gone: string[] = [];
  const flagged: ReviewedWorktree[] = [];
  for (const path of await worktreePaths(db, dispatches, input.host)) {
    const status = input.worktreeStatus(path);
    if (status === null) gone.push(path);
    else if (status.files.length > 0 || status.ahead > 0)
      flagged.push({ path, ...status });
  }
  if (flagged.length > 0 && !input.keepFilesReviewed)
    return {
      ok: false,
      refusal: filesRefusal(flagged, input.story, input.generation),
    };
  if (run.host !== input.host)
    return refuse(
      "wrong_host",
      `Run ${run.run_id} belongs to host ${run.host}, and this close runs on ${input.host}`,
      [
        `run pod run close story:${input.story} --generation ${input.generation} on host ${run.host}`,
      ],
    );

  const archiveKey = closeStepKey(run.run_id, "archive");
  const archiveRow = await db.getOperation(archiveKey);
  const archived = Recorded.safeParse(archiveRow?.result_ref);
  if (
    archived.success &&
    archived.data.request.report_hash !== input.reportHash
  )
    return refuse(
      "duplicate_op",
      `the close of Run ${run.run_id} recorded report ${archived.data.request.report_hash}`,
      ["pass the same FILE as the first close"],
    );
  if (input.tracker === null) return { ok: false, refusal: noTracker };

  const prs = await db.listEvents(run.run_id, "pr");
  const plan =
    archiveRow?.status === "done"
      ? []
      : await planWorktrees(db, dispatches, input.host, input.git);
  if (archiveRow?.status !== "done") {
    const open = await openPrRefusal(
      await readPrs(prs, dispatches, plan, input.codeHost),
      plan,
      input.codeHost,
      againCommand(input),
    );
    if (open !== null) return { ok: false, refusal: open };
  }
  const receipts = await db.listGateReceipts(run.run_id);
  const { snapshot, policy, process } = await pinned(db, run);
  const names = storyStatusOf(policy);
  const ctx: Context = {
    db,
    run,
    input,
    tracker: input.tracker,
    orca,
    dispatches,
    log,
    snapshot,
    status:
      names === null
        ? null
        : humanGatePending(policy, process, snapshot.profile, receipts)
          ? names.human_wait
          : names.done,
    archive: {
      op_key: archiveKey,
      snapshot_hash: run.snapshot_hash,
      report_hash: input.reportHash,
      report: {
        learnings: input.report.learnings.length,
        leftovers: input.report.leftovers.length,
        decisions: input.report.decisions.length,
      },
      dispatches: dispatches.map((row) => ({
        dispatch_id: row.dispatch_id,
        seat: row.seat,
        role: row.role,
        model_attribution: row.model_attribution,
        settlement: row.settlement,
      })),
      seats: seatsOf(dispatches),
      pr_events: prs.map((event) => event.id),
      keep_files_reviewed:
        flagged.length === 0
          ? null
          : { actor: "operator", host: input.host, worktrees: flagged },
      gone,
      worktrees: plan,
      retro_due: retroDue(story, receipts),
      actor: input.actor,
    },
  };
  const replayed = new Set<CloseStepName>();
  for (const step of closeSteps) {
    const outcome = await runStep(step, ctx);
    if ("ok" in outcome) return outcome;
    if (outcome.replayed) replayed.add(step.name);
  }
  const done = await db.getRun(run.run_id);
  if (done === null) throw new Error(`Run ${run.run_id} vanished`);
  return closedResult(
    db,
    done,
    input.story,
    stepRows(run.run_id, replayed),
    false,
  );
}
