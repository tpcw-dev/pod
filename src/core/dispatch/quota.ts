import { z } from "zod";
import type { Activity, Operation, OperationStatus } from "../domain/ledger.ts";
import type { Repo } from "../ports/db.ts";

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

const LaunchRequest = z.looseObject({
  request: z.looseObject({
    task_id: z.string().optional(),
    host: z.string().optional(),
  }),
});

export type OpenLaunch = Pick<
  Operation,
  "op_key" | "intent" | "status" | "result_ref"
> & { request: z.infer<typeof LaunchRequest>["request"] | null };

export async function openLaunches(tx: Repo): Promise<OpenLaunch[]> {
  return (await tx.launchReservations(launchIntents)).map((row) => ({
    ...row,
    request: LaunchRequest.safeParse(row.result_ref).data?.request ?? null,
  }));
}

export function onHost(
  launches: readonly OpenLaunch[],
  host: string,
): OpenLaunch[] {
  return launches.filter((row) => (row.request?.host ?? host) === host);
}

export async function hostFreeSlots(
  tx: Repo,
  host: string,
  capacity: number,
): Promise<number> {
  return freeSlots(
    capacity,
    await tx.hostActivities(host),
    onHost(await openLaunches(tx), host),
  );
}
