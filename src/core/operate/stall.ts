import { z } from "zod";
import { singleActive } from "../config/active.ts";
import { stallMinutes } from "../config/limits.ts";
import { exhausted, spentNow } from "../decide/budget.ts";
import type { BriefRun } from "../domain/brief.ts";
import { openStates } from "../domain/decision.ts";
import type { Dispatch, Event } from "../domain/ledger.ts";
import { budgetOf } from "../domain/policy.ts";
import type { NeedsHumanKind, NeedsHumanLine } from "../domain/tick.ts";
import type { Repo } from "../ports/db.ts";

export interface HostRun {
  story: string;
  run: BriefRun["run"];
  tasks: BriefRun["tasks"];
  dispatches: readonly Dispatch[];
}

export interface Stalls {
  runs: HostRun[];
  silent: Dispatch[];
  lines: NeedsHumanLine[];
}

const EscalationText = z.looseObject({ text: z.string() });

export function needsHumanLine(
  kind: NeedsHumanKind,
  run: HostRun,
  since: Date,
  text: string,
  ids: Partial<
    Pick<NeedsHumanLine, "task_id" | "dispatch_id" | "decision_id" | "event_id">
  > = {},
): NeedsHumanLine {
  return {
    kind,
    run_id: run.run.run_id,
    story: run.story,
    task_id: ids.task_id ?? null,
    dispatch_id: ids.dispatch_id ?? null,
    decision_id: ids.decision_id ?? null,
    event_id: ids.event_id ?? null,
    since: since.toISOString(),
    text,
  };
}

function compareNullable<T extends string | number>(
  a: T | null,
  b: T | null,
): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** The replay order: a ledger read sorted this way writes the same tick payload bytes. */
export function sortLines(lines: readonly NeedsHumanLine[]): NeedsHumanLine[] {
  return [...lines].sort(
    (a, b) =>
      compareNullable(a.kind, b.kind) ||
      compareNullable(a.run_id, b.run_id) ||
      compareNullable(a.since, b.since) ||
      compareNullable(a.task_id, b.task_id) ||
      compareNullable(a.dispatch_id, b.dispatch_id) ||
      compareNullable(a.decision_id, b.decision_id) ||
      compareNullable(a.event_id, b.event_id),
  );
}

export async function hostRuns(repo: Repo, host: string): Promise<HostRun[]> {
  const tree = await repo.readBrief(null);
  return tree.stories.flatMap((story) =>
    story.runs
      .filter((each) => each.run.host === host)
      .map((each) => ({
        story: story.story.external_id,
        run: each.run,
        tasks: each.tasks,
        dispatches: each.dispatches,
      })),
  );
}

function newest(events: readonly Event[]): Event | null {
  return events.reduce<Event | null>(
    (found, each) => (found === null || each.id > found.id ? each : found),
    null,
  );
}

async function runStalls(
  repo: Repo,
  run: HostRun,
  now: Date,
  minutes: number,
): Promise<{ silent: Dispatch[]; lines: NeedsHumanLine[] }> {
  const runId = run.run.run_id;
  const deliveries = await repo.listEvents(runId, "delivery");
  const lines: NeedsHumanLine[] = [];
  const silent: Dispatch[] = [];
  for (const dispatch of run.dispatches) {
    const delivered = newest(
      deliveries.filter((each) => each.dispatch_id === dispatch.dispatch_id),
    );
    if (delivered === null) silent.push(dispatch);
    if (dispatch.activity !== "running") continue;
    const since = delivered?.ts ?? dispatch.created_at;
    if (now.getTime() - since.getTime() <= minutes * 60_000) continue;
    lines.push(
      needsHumanLine(
        "dispatch_silent",
        run,
        since,
        `Dispatch ${dispatch.dispatch_id} is running with no delivery for more than ${minutes} minutes`,
        { task_id: dispatch.task_id, dispatch_id: dispatch.dispatch_id },
      ),
    );
  }
  for (const task of run.tasks)
    if (
      task.state === "ready" &&
      !run.dispatches.some((each) => each.task_id === task.task_id)
    )
      lines.push(
        needsHumanLine(
          "task_unlaunched",
          run,
          task.created_at,
          `Task ${task.task_id} is ready with no Dispatch`,
          { task_id: task.task_id },
        ),
      );
  if (run.run.state === "hold") {
    const held = newest(await repo.listEvents(runId, "hold"));
    lines.push(
      needsHumanLine(
        "run_hold",
        run,
        held?.ts ?? run.run.created_at,
        `Run ${runId} is in hold`,
        held === null ? {} : { event_id: held.id },
      ),
    );
  }
  for (const decision of await repo.listRunDecisions(runId)) {
    if (decision.state === "needs_human")
      lines.push(
        needsHumanLine(
          "decision_needs_human",
          run,
          decision.closed_at ?? decision.created_at,
          `Decision ${decision.id} needs a person: ${decision.reason ?? "unknown"}`,
          { task_id: decision.task_id, decision_id: decision.id },
        ),
      );
    if (!openStates.includes(decision.state)) continue;
    const field = exhausted(budgetOf(decision.budget), spentNow(decision, now));
    if (field !== null)
      lines.push(
        needsHumanLine(
          "decision_over_budget",
          run,
          decision.created_at,
          `Decision ${decision.id} is over its ${field} budget`,
          { task_id: decision.task_id, decision_id: decision.id },
        ),
      );
  }
  for (const event of await repo.listEvents(runId, "escalate"))
    lines.push(
      needsHumanLine(
        "escalation",
        run,
        event.ts,
        EscalationText.safeParse(event.payload).data?.text ??
          `escalate event ${event.id}`,
        { task_id: event.task_id, event_id: event.id },
      ),
    );
  return { silent, lines };
}

/**
 * Reads the stalls of a host's Runs from ledger timestamps alone. A done Run
 * stays in the read because `pod run close` writes its p0 escalations.
 */
export async function findStalls(
  repo: Repo,
  host: string,
  now: Date,
): Promise<Stalls> {
  const policy = await singleActive(repo, "policy", "global", "");
  const minutes = stallMinutes(policy?.value);
  const runs = await hostRuns(repo, host);
  const silent: Dispatch[] = [];
  const lines: NeedsHumanLine[] = [];
  for (const run of runs) {
    const found = await runStalls(repo, run, now, minutes);
    silent.push(...found.silent);
    lines.push(...found.lines);
  }
  return { runs, silent, lines };
}
