import { z } from "zod";
import type { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";

const Waiting = z.looseObject({ coordinator_waiting: z.string() });

export async function yieldDispatch(
  tx: Repo,
  dispatchId: string,
  at: Date,
): Promise<string | null> {
  const coordinator = await tx.getDispatch(dispatchId);
  if (coordinator?.settlement !== "open" || coordinator.activity !== "running")
    return null;
  await tx.setDispatchActivity(dispatchId, "waiting", at);
  return dispatchId;
}

export function handoffOf(ref: Json | null | undefined): {
  coordinator_waiting?: string;
} {
  const waiting = Waiting.safeParse(ref);
  return waiting.success
    ? { coordinator_waiting: waiting.data.coordinator_waiting }
    : {};
}

export async function returnSlot(
  tx: Repo,
  ref: Json | null,
  at: Date,
): Promise<void> {
  const { coordinator_waiting: id } = handoffOf(ref);
  if (id === undefined) return;
  const coordinator = await tx.getDispatch(id);
  if (coordinator?.activity !== "waiting") return;
  await tx.setDispatchActivity(id, "running", at);
}
