import type { Refusal } from "../domain/outcome.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import type { Repo } from "../ports/db.ts";
import { freeSlots, onHost, type OpenLaunch } from "./quota.ts";

export async function drainRefusal(
  tx: Repo,
  runId: string,
): Promise<Refusal | null> {
  if (!(await drainInForce(tx, runId))) return null;
  return {
    code: "drained",
    message: `a drain is in force on Run ${runId}`,
    nextSteps: [
      "pod check",
      "pod release",
      "this refusal is recorded under its op key; pass a new --op-key once the drain ends",
    ],
  };
}

export async function slotRefusal(
  tx: Repo,
  host: string,
  capacity: number,
  launches: readonly OpenLaunch[],
): Promise<Refusal | null> {
  const reservations = onHost(launches, host);
  const slots = freeSlots(
    capacity,
    await tx.hostActivities(host),
    reservations,
  );
  if (slots >= 1) return null;
  return {
    code: "quota_exhausted",
    message: `no free slot on host ${host}`,
    nextSteps: [
      ...reservations.map(
        (row) => `reservation ${row.op_key} is ${row.status}`,
      ),
      "running Dispatches on this host hold the rest",
      "pod check --wait",
      "this refusal is recorded under its op key; pass a new --op-key once a slot frees",
    ],
  };
}
