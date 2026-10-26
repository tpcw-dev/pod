import type { Activity, OperationStatus } from "../domain/ledger.ts";

export const launchIntents = ["dispatch", "retry", "decide_seat"] as const;

export interface Reservation {
  intent: string;
  status: OperationStatus;
}

export function freeSlots(
  capacity: number,
  activities: readonly Activity[],
  reservations: readonly Reservation[],
): number {
  const running = activities.filter((activity) => activity === "running");
  const held = reservations.filter(
    (row) =>
      (launchIntents as readonly string[]).includes(row.intent) &&
      (row.status === "pending" || row.status === "unknown"),
  );
  return capacity - running.length - held.length;
}
