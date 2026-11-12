import { digestCap } from "../config/digest-cap.ts";
import type { DigestBrief } from "../domain/brief.ts";
import { dayOf, scopeOf } from "../domain/digest.ts";
import type { Repo } from "../ports/db.ts";
import { tuningQueue } from "./queue.ts";

export async function digestBrief(
  repo: Repo,
  project: string | null,
  now: () => Date,
): Promise<DigestBrief> {
  const scope = scopeOf(project);
  const today = await repo.listShownProposals(scope, dayOf(now()));
  const open = await repo.listOpenProposals(scope);
  return {
    cap: await digestCap(repo, project),
    shown: today.length,
    queued: open.filter((row) => row.shown_on === null).length,
    open: open.filter((row) => row.shown_on !== null).length,
    queue: (await tuningQueue(repo, project)).length,
    proposals: today.map((row) => ({
      number: row.id,
      theme: row.theme,
      text: row.text,
      evidence_refs: row.evidence_refs,
      ruling: row.ruling ?? "open",
    })),
  };
}
