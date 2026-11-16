import type { OrcaPort, WorkerRow } from "../ports/orca.ts";

export async function listWorkers(
  orca: OrcaPort,
  run: string,
): Promise<WorkerRow[] | null> {
  const rows: WorkerRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await orca.workerList({
      run,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.exitCode !== 0 || page.result === null) return null;
    rows.push(...page.result.workers);
    const next = page.result.page.nextCursor;
    if (next === null || next === undefined) return rows;
    cursor = next;
  }
}

/**
 * Reads the worker list with no Run filter. The worker runtime scopes that
 * list to the Run bound to the calling terminal when there is one, so a list
 * whose scope is not every Run is returned as its scope instead of its rows.
 */
export async function listAllWorkers(
  orca: OrcaPort,
): Promise<{ rows: WorkerRow[] } | { scope: string }> {
  const rows: WorkerRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await orca.workerList(cursor === undefined ? {} : { cursor });
    if (page.exitCode !== 0 || page.result === null)
      return { scope: "unreadable" };
    const source = page.result.scope?.source ?? "missing";
    if (source !== "all") return { scope: source };
    rows.push(...page.result.workers);
    const next = page.result.page.nextCursor;
    if (next === null || next === undefined) return { rows };
    cursor = next;
  }
}

export function memoWorkers(
  orca: OrcaPort,
  run: string,
): () => Promise<WorkerRow[] | null> {
  let rows: Promise<WorkerRow[] | null> | null = null;
  return () => (rows ??= listWorkers(orca, run));
}
