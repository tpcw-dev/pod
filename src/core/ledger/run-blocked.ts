import type { Event } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

export async function runBlocked(
  db: Repo,
  runId: string,
): Promise<Event | null> {
  const cancel = await db.firstEvent(runId, ["cancel"]);
  const stop = await db.firstEvent(runId, ["stop"], { runWide: true });
  if (cancel === null || stop === null) return cancel ?? stop;
  const first = cancel.ts.getTime() - stop.ts.getTime() || cancel.id - stop.id;
  return first <= 0 ? cancel : stop;
}
