import { z } from "zod";
import { storyStatusOf } from "../config/policy.ts";
import { CloseReport } from "../domain/close.ts";
import type { Run, RunState } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export const observedStates: readonly RunState[] = [
  "active",
  "hold",
  "drained",
];

const finished = ["done", "superseded", "failed"];

const Carries = z.looseObject({ close_report: z.unknown() });

const Recorded = z.looseObject({
  close_report: CloseReport,
  report_hash: z.string().min(1),
});

export interface RecordedReport {
  event_id: number;
  report: CloseReport;
  report_hash: string;
}

export interface CloseCandidate {
  run: Run;
  report: RecordedReport | null;
}

async function completionStatus(repo: Repo, run: Run): Promise<string | null> {
  const snapshot = await repo.getSnapshot(run.run_id);
  const policy =
    snapshot === null
      ? null
      : await repo.getRevision(snapshot.policy_revision_id);
  return storyStatusOf(policy?.value)?.done ?? null;
}

export async function newestCloseReport(
  repo: Repo,
  runId: string,
): Promise<RecordedReport | null> {
  const deliveries = await repo.listEvents(runId, "delivery");
  for (const row of [...deliveries].sort((a, b) => b.id - a.id)) {
    if (Carries.safeParse(row.payload).data?.close_report === undefined)
      continue;
    const parsed = Recorded.safeParse(row.payload);
    return parsed.success
      ? {
          event_id: row.id,
          report: parsed.data.close_report,
          report_hash: parsed.data.report_hash,
        }
      : null;
  }
  return null;
}

/**
 * A Run of the host is a close candidate when its Story's tracker status is
 * the pinned policy's story_status.done and every Task is finished.
 */
export async function closeCandidates(
  repo: Repo,
  host: string,
): Promise<CloseCandidate[]> {
  const candidates: CloseCandidate[] = [];
  for (const run of await repo.listHostRuns(host, observedStates)) {
    const done = await completionStatus(repo, run);
    const story = await repo.getStory(
      run.story_provider,
      run.story_external_id,
    );
    if (done === null || story?.status !== done) continue;
    const tasks = await repo.listTasks(run.run_id);
    if (!tasks.every((task) => finished.includes(task.state))) continue;
    candidates.push({
      run,
      report: await newestCloseReport(repo, run.run_id),
    });
  }
  return candidates;
}
