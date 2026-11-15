import { z } from "zod";
import { activeSchedule } from "../config/schedule.ts";
import { Json } from "../domain/json.ts";
import type { Run } from "../domain/ledger.ts";
import type { Db } from "../ports/db.ts";
import { closeRun } from "../run/close.ts";
import { closeCandidates, type CloseCandidate } from "./close-candidates.ts";
import type { OperatePorts } from "./ports.ts";
import type { StepContext, StepResult } from "./tick.ts";
import { newestTick, tickEvents } from "./triggers.ts";

export const NeedsHuman = z.strictObject({
  run_id: z.string(),
  story: z.string(),
  code: z.string(),
  message: z.string(),
  since: z.iso.datetime(),
  last_event_id: z.number().nullable(),
  held: z.boolean(),
});
export type NeedsHuman = z.infer<typeof NeedsHuman>;

const CloseDetail = z.looseObject({ needs_human: z.array(NeedsHuman) });

async function previousLines(db: Db, host: string): Promise<NeedsHuman[]> {
  const newest = newestTick(await tickEvents(db, host));
  const step = newest?.payload.steps.find((each) => each.step === "close");
  return CloseDetail.safeParse(step?.detail).data?.needs_human ?? [];
}

function stillHeld(
  line: NeedsHuman | undefined,
  newestEvent: number | null,
  holdMinutes: number,
  now: Date,
): line is NeedsHuman {
  if (line === undefined) return false;
  const quiet = (newestEvent ?? 0) <= (line.last_event_id ?? 0);
  return quiet && now.getTime() - Date.parse(line.since) < holdMinutes * 60_000;
}

async function runningDispatches(db: Db, run: Run): Promise<string[]> {
  return (await db.listDispatches(run.run_id))
    .filter((row) => row.activity === "running")
    .map((row) => row.dispatch_id);
}

type Attempt =
  | { kind: "closed"; closed: Json }
  | { kind: "refused"; code: string; message: string };

async function attempt(
  ports: OperatePorts,
  ctx: Pick<StepContext, "db" | "writer" | "now" | "actor">,
  candidate: CloseCandidate,
): Promise<Attempt> {
  const { db } = ctx;
  if (candidate.report === null)
    return {
      kind: "refused",
      code: "no_close_report",
      message: `Run ${candidate.run.run_id} has no close_report delivery from its lead`,
    };
  const run = await db.getRun(candidate.run.run_id);
  if (run === null)
    return {
      kind: "refused",
      code: "failed",
      message: `Run ${candidate.run.run_id} is gone`,
    };
  const running = await runningDispatches(db, run);
  if (running.length > 0)
    return {
      kind: "refused",
      code: "dispatch_running",
      message: `Run ${run.run_id} has a running Dispatch: ${running.join(", ")}`,
    };
  const closed = await closeRun(db, ports.orca, ports.log, {
    story: run.story_external_id,
    provider: ports.provider,
    generation: run.owner_generation,
    report: candidate.report.report,
    reportHash: candidate.report.report_hash,
    keepFilesReviewed: false,
    host: ctx.writer,
    worktreeStatus: ports.worktreeStatus,
    now: () => ctx.now,
    tracker: ports.tracker,
    codeHost: ports.codeHost,
    git: ports.git,
    actor: ctx.actor,
  });
  if (!closed.ok)
    return {
      kind: "refused",
      code: closed.refusal.code,
      message: closed.refusal.message,
    };
  return {
    kind: "closed",
    closed: {
      run_id: run.run_id,
      already_closed: closed.result.already_closed,
      report_hash: closed.result.report_hash,
    },
  };
}

/**
 * Closes each close candidate of the host from its lead's newest close
 * report. A Run with no report, a running Dispatch, or a refused close gets a
 * needs_human line, held until the Run gains an event or hold_minutes pass.
 */
export async function closeStep(
  ports: OperatePorts,
  ctx: Pick<StepContext, "db" | "host" | "writer" | "now" | "actor">,
): Promise<StepResult> {
  const { db, now } = ctx;
  const schedule = await activeSchedule(db, ctx.host);
  const holdMinutes = schedule?.value.hold_minutes ?? 0;
  const previous = await previousLines(db, ctx.host);
  const closed: Json[] = [];
  const needsHuman: NeedsHuman[] = [];
  for (const candidate of await closeCandidates(db, ctx.host)) {
    const { run } = candidate;
    const newestEvent = await db.newestRunEventId(run.run_id);
    const prior = previous.find((line) => line.run_id === run.run_id);
    if (stillHeld(prior, newestEvent, holdMinutes, now)) {
      needsHuman.push({ ...prior, held: true });
      continue;
    }
    let outcome: Attempt;
    try {
      outcome = await attempt(ports, ctx, candidate);
    } catch (error) {
      outcome = {
        kind: "refused",
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.kind === "closed") {
      closed.push(outcome.closed);
      continue;
    }
    needsHuman.push({
      run_id: run.run_id,
      story: `story:${run.story_external_id}`,
      code: outcome.code,
      message: outcome.message,
      since: now.toISOString(),
      last_event_id: await db.newestRunEventId(run.run_id),
      held: false,
    });
  }
  return {
    result: "ok",
    detail: Json.parse({ closed, needs_human: needsHuman }),
  };
}
