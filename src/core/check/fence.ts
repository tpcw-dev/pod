import type { Run } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export class StaleGeneration extends Error {
  constructor(readonly run: Run) {
    super("stale generation");
  }
}

export async function fence(
  tx: Repo,
  runId: string,
  generation: number,
): Promise<Run> {
  const run = await tx.getRun(runId);
  if (run === null) throw new Error(`Run ${runId} vanished`);
  if (run.owner_generation !== generation) throw new StaleGeneration(run);
  return run;
}
