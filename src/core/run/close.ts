import { z } from "zod";
import {
  CloseStepName,
  KeepFilesReviewed,
  type CloseReport,
  type ReviewedWorktree,
  type CloseResult,
  type WorktreeStatus,
} from "../domain/close.ts";
import { openStates } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch, Event, Run } from "../domain/ledger.ts";
import { refuse, type Refusal, type Refused } from "../domain/outcome.ts";
import { dispatchWorktree } from "../dispatch/retry.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
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
}

interface Context {
  db: Db;
  run: Run;
  input: CloseInput;
  archive: Archive;
}

interface CloseStep {
  name: CloseStepName;
  act(tx: Repo, ctx: Context): Promise<Json>;
  readBack(db: Repo, ctx: Context): Promise<Json | null>;
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
        source: { kind: "command", verb: "run close" },
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
      "answer or clear the composer, then run the close again",
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
      already_closed: alreadyClosed,
      nextSteps: [],
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

async function runStep(
  step: CloseStep,
  ctx: Context,
): Promise<{ replayed: boolean } | Refused> {
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
  if (row !== null) {
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
  return db.transaction(async (tx) => {
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
    const result = await step.act(tx, ctx);
    await tx.moveOperation(opKey, "done", Json.parse({ request, result }), at);
    return { replayed: false };
  });
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

export async function closeRun(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: CloseInput,
): Promise<Closed> {
  const story = await db.getStory(input.provider, input.story);
  const run = story?.run_id == null ? null : await db.getRun(story.run_id);
  if (run === null)
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

  const archiveKey = closeStepKey(run.run_id, "archive");
  const archived = Recorded.safeParse(
    (await db.getOperation(archiveKey))?.result_ref,
  );
  if (
    archived.success &&
    archived.data.request.report_hash !== input.reportHash
  )
    return refuse(
      "duplicate_op",
      `the close of Run ${run.run_id} recorded report ${archived.data.request.report_hash}`,
      ["pass the same FILE as the first close"],
    );

  const prs = await db.listEvents(run.run_id, "pr");
  const ctx: Context = {
    db,
    run,
    input,
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
