import { DrainPayload } from "../domain/drain.ts";
import type { Repo } from "../ports/db.ts";

export async function drainInForce(tx: Repo, runId: string): Promise<boolean> {
  const drain = await tx.latestEvent(runId, "drain");
  if (drain === null) return false;
  const payload = DrainPayload.safeParse(drain.payload);
  return payload.success && !payload.data.ended;
}
