import { digestCap } from "../config/digest-cap.ts";
import { dayOf, scopeOf } from "../domain/digest.ts";
import type { Repo } from "../ports/db.ts";

const failWindowMs = 72 * 60 * 60 * 1000;

export interface PrepareInput {
  project: string | null;
  now: () => Date;
}

export async function prepareDigest(repo: Repo, input: PrepareInput) {
  const now = input.now();
  const scope = scopeOf(input.project);
  const open = await repo.listOpenProposals(scope);
  const queued = open.filter((row) => row.shown_on === null);
  const claimed = new Set(queued.flatMap((row) => row.learning_ids));
  const learnings = await repo.listLearnings({
    adoption: "new",
    project: input.project,
  });
  const receipts = await repo.failReceiptsSince(
    new Date(now.getTime() - failWindowMs),
    input.project,
  );
  const watermark = await repo.latestEventWith("digest", { scope });
  return {
    scope,
    day: dayOf(now),
    cap: await digestCap(repo, input.project),
    watermark: watermark?.ts.toISOString() ?? null,
    learnings: learnings
      .filter((row) => !claimed.has(row.id))
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        area: row.area,
        text: row.text,
        expected: row.expected,
        evidence_refs: row.evidence_refs,
        source_story: row.source_story,
        occurrences: row.occurrences,
      })),
    fail_receipts: receipts.map((row) => ({
      id: row.id,
      gate_id: row.gate_id,
      run_id: row.run_id,
      task_id: row.task_id,
      scope: row.scope,
      candidate_sha: row.candidate_sha,
      keeper: row.keeper,
      created_at: row.created_at.toISOString(),
    })),
    queued: queued.map((row) => ({
      number: row.id,
      posted_on: row.posted_on,
      theme: row.theme,
      text: row.text,
      learning_ids: row.learning_ids,
      evidence_refs: row.evidence_refs,
    })),
  };
}

export type DigestPacket = Awaited<ReturnType<typeof prepareDigest>>;
