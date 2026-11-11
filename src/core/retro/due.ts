import { z } from "zod";
import type { Run } from "../domain/ledger.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import { RetroRecorded } from "../domain/retro.ts";
import type { Repo } from "../ports/db.ts";
import { ArchiveRecord, closeStepKey } from "../run/close-record.ts";

export function retroOpKey(runId: string): string {
  return `retro:${runId}`;
}

const Done = z.looseObject({ result: RetroRecorded });

export async function recordedRetro(
  db: Repo,
  runId: string,
): Promise<RetroRecorded | null> {
  const row = await db.getOperation(retroOpKey(runId));
  if (row?.status !== "done") return null;
  return Done.safeParse(row.result_ref).data?.result ?? null;
}

export interface DueRun {
  run: Run;
  archive: z.infer<typeof ArchiveRecord>;
}

export async function dueRun(
  db: Repo,
  runId: string,
): Promise<DueRun | Refused> {
  const run = await db.getRun(runId);
  if (run === null)
    return refuse("task_not_ready", `no Run ${runId}`, ["pod brief"]);
  const close = await db.eventWith("close", {
    op_key: closeStepKey(runId, "archive"),
  });
  if (close === null)
    return refuse("retro_not_due", `Run ${runId} has no close event`, [
      `pod run close story:${run.story_external_id} --generation ${run.owner_generation}`,
    ]);
  const archive = ArchiveRecord.parse(close.payload);
  if (!archive.retro_due)
    return refuse("retro_not_due", `Run ${runId} closed with retro_due false`, [
      "this Run is not due a retro; nothing to run",
    ]);
  return { run, archive };
}
