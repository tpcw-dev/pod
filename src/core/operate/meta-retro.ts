import { readSeats } from "../dispatch/seats.ts";
import { Json } from "../domain/json.ts";
import type { Run } from "../domain/ledger.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { CodeHostPort } from "../ports/code-host.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { hostCapacity } from "../plan/capacity.ts";
import { ProcessValue } from "../process/schema.ts";
import { recordedRetro } from "../retro/due.ts";
import { retroRun, retroStep } from "../retro/run.ts";
import { closeStepKey } from "../run/close-record.ts";
import type { MetaStep, MetaStepContext, MetaStepResult } from "./meta.ts";
import { subjectId, type PacketItem, type PacketInput } from "./packet.ts";

export interface RetroDeps {
  orca: OrcaPort;
  log: ReceiptLog;
  codeHost: CodeHostPort;
}

export const retroInput: PacketInput = async (repo, ctx) => {
  const items: PacketItem[] = [];
  for (const close of await repo.eventsWith("close", { retro_due: true })) {
    const runId = close.run_id;
    if (runId === null || close.op_key !== closeStepKey(runId, "archive"))
      continue;
    const run = await repo.getRun(runId);
    if (run?.host !== ctx.host) continue;
    if ((await recordedRetro(repo, runId)) !== null) continue;
    if ((await repo.listEvents(runId, "retro")).length > 0) continue;
    items.push({
      event_id: close.id,
      ts: close.ts,
      kind: "evidence",
      text: `run ${runId} story ${run.story_provider}:${run.story_external_id}`,
      subject: `run:${runId}`,
    });
  }
  return items;
};

async function retroRole(repo: Repo, processRevision: string) {
  const process = await repo.getRevision(processRevision);
  const step = ProcessValue.safeParse(process?.value).data?.steps.find(
    (row) => row.id === retroStep,
  );
  return step?.role ?? retroStep;
}

export async function retroSeat(
  repo: Repo,
  run: Run,
  host: string,
): Promise<string | null> {
  const snapshot = await repo.getSnapshot(run.run_id);
  if (snapshot === null) return null;
  const task = (await repo.listTasks(run.run_id)).find(
    (row) => row.step_id === retroStep,
  );
  const dispatches = await repo.listDispatches(run.run_id);
  const held = dispatches.find((row) => row.task_id === task?.task_id);
  if (task !== undefined && held !== undefined) return held.seat;
  const crew = await repo.getRevision(snapshot.crew_revision_id);
  if (crew === null) return null;
  const role = await retroRole(repo, snapshot.process_revision_id);
  const busy = new Set(
    dispatches
      .filter((row) => row.task_id !== task?.task_id)
      .map((row) => row.seat),
  );
  const seat = readSeats(crew.value).find(
    (row) =>
      row.roles.includes(role) &&
      (row.host === undefined || row.host === host) &&
      !busy.has(row.id),
  );
  return seat?.id ?? null;
}

interface RetroLine {
  run_id: string;
  state: string;
  dispatch_id: string | null;
}

async function retroOne(
  db: Db,
  deps: RetroDeps,
  ctx: MetaStepContext,
  runId: string,
  capacity: number | null,
): Promise<RetroLine> {
  const run = await db.getRun(runId);
  if (run === null)
    return { run_id: runId, state: "no_run", dispatch_id: null };
  const seat = await retroSeat(db, run, ctx.host);
  if (seat === null)
    return { run_id: runId, state: "no retro seat", dispatch_id: null };
  const outcome = await retroRun(db, deps.orca, deps.log, {
    run: runId,
    seat,
    generation: run.owner_generation,
    attempt: "1",
    host: ctx.host,
    capacity,
    codeHost: deps.codeHost,
    command: `pod retro run:${runId} --seat ${seat} --generation ${run.owner_generation}`,
    now: () => ctx.now,
  });
  if (!outcome.ok)
    return { run_id: runId, state: outcome.refusal.code, dispatch_id: null };
  return {
    run_id: runId,
    state: outcome.result.state,
    dispatch_id: outcome.result.dispatch_id,
  };
}

async function runRetro(
  deps: RetroDeps,
  ctx: MetaStepContext,
): Promise<MetaStepResult> {
  const capacity = await hostCapacity(ctx.db, ctx.host, ctx.now);
  const runs: RetroLine[] = [];
  for (const item of ctx.packet.items) {
    const runId =
      item.subject === undefined ? null : subjectId(item.subject, "run");
    if (runId === null) continue;
    try {
      runs.push(await retroOne(ctx.db, deps, ctx, runId, capacity));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runs.push({ run_id: runId, state: message, dispatch_id: null });
    }
  }
  const done = runs.every(
    (row) => row.state === "dispatched" || row.state === "recorded",
  );
  return {
    result: done ? "ok" : "failed",
    detail: Json.parse({ runs, held: ctx.packet.held }),
  };
}

export function retroMetaStep(deps: RetroDeps): MetaStep {
  return {
    name: "retro",
    built: true,
    output: "retro",
    scope: (host) => `host:${host}`,
    input: retroInput,
    run: (ctx) => runRetro(deps, ctx),
  };
}
