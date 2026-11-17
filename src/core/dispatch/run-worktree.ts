import { z } from "zod";
import { operationStatuses, type Run } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export const LaunchRequest = z.object({
  launch: z.literal(true),
  host: z.string(),
  project: z.string(),
  story: z.string(),
  subject: z.string(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const LaunchWorktree = z.object({
  id: z.string(),
  path: z.string(),
  branch: z.string(),
});

const Launched = z.object({
  request: LaunchRequest,
  run_id: z.string(),
  worktree: LaunchWorktree,
});

export async function launchedWorktrees(
  db: Repo,
  run: Run,
  host = run.host,
): Promise<string[]> {
  const selectors = new Set<string>();
  for (const row of await db.listOperations(["tick"], operationStatuses)) {
    const launched = Launched.safeParse(row.result_ref).data;
    if (launched?.run_id === run.run_id && launched.request.host === host)
      selectors.add(`id:${launched.worktree.id}`);
  }
  return [...selectors];
}

/** The worktree a later Dispatch of the Run on `host` starts in: its launch's, else the caller's. */
export async function runWorktree(
  db: Repo,
  run: Run,
  host: string,
): Promise<string> {
  const own = await launchedWorktrees(db, run, host);
  if (own.length > 1)
    throw new Error(
      `Run ${run.run_id} has ${own.length} launch worktrees on host ${host}`,
    );
  return own[0] ?? "current";
}
