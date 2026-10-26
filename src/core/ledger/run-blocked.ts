import type { Event } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export function runBlocked(db: Repo, runId: string): Promise<Event | null> {
  return db.firstEvent(runId, ["stop", "cancel"]);
}
