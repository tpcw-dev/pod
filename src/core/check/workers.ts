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

export function memoWorkers(
  orca: OrcaPort,
  run: string,
): () => Promise<WorkerRow[] | null> {
  let rows: Promise<WorkerRow[] | null> | null = null;
  return () => (rows ??= listWorkers(orca, run));
}
