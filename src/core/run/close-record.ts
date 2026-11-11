import { z } from "zod";
import {
  BranchOutcome,
  KeepFilesReviewed,
  P0Kind,
  PlannedWorktree,
  WorktreeOutcome,
  type CloseStepName,
} from "../domain/close.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Repo } from "../ports/db.ts";
import {
  branchesRemovedField,
  remoteKeptField,
  worktreeField,
} from "./close-effects.ts";

export function closeStepKey(runId: string, step: CloseStepName): string {
  return derivedOpKey("close", { run: runId, step });
}

const LearningsResult = z.looseObject({
  result: z.looseObject({ learning_ids: z.array(z.int()) }),
});

export async function learningIds(db: Repo, runId: string): Promise<number[]> {
  const row = await db.getOperation(closeStepKey(runId, "learnings"));
  return (
    LearningsResult.safeParse(row?.result_ref).data?.result.learning_ids ?? []
  );
}

const EscalateEvent = z.looseObject({ kind: P0Kind, text: z.string() });

export async function escalations(db: Repo, runId: string) {
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

export const BranchesPartial = z.looseObject({
  partial: z.array(BranchOutcome),
});

export async function worktreeOutcomes(db: Repo, runId: string) {
  const row = await db.getOperation(closeStepKey(runId, "worktree"));
  return (
    WorktreeStepResult.safeParse(row?.result_ref).data?.result.worktrees ?? []
  );
}

export async function branchOutcomes(db: Repo, runId: string) {
  const row = await db.getOperation(closeStepKey(runId, "branches"));
  return (
    BranchesStepResult.safeParse(row?.result_ref).data?.result.branches ?? []
  );
}

export async function archivedRecord(db: Repo, runId: string) {
  const archived = await db.eventWith("close", {
    op_key: closeStepKey(runId, "archive"),
  });
  return ArchiveRecord.parse(archived?.payload ?? {});
}

export const ArchiveRecord = z.looseObject({
  report_hash: z.string().catch(""),
  report: z
    .object({ learnings: z.int(), leftovers: z.int(), decisions: z.int() })
    .catch({ learnings: 0, leftovers: 0, decisions: 0 }),
  keep_files_reviewed: KeepFilesReviewed.nullable().catch(null),
  gone: z.array(z.string()).catch([]),
  worktrees: z.array(PlannedWorktree).catch([]),
  retro_due: z.boolean().catch(false),
});

export function commentBody(
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
