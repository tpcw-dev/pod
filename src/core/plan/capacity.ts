import { activeHostRevision } from "../config/host.ts";
import type { Repo } from "../ports/db.ts";
import {
  planEvents,
  stretchInForce,
  type StretchInForce,
} from "./overrides.ts";

export function capacityOf(
  slots: { default: number; max: number },
  stretch: StretchInForce | null,
): number {
  return stretch === null ? slots.default : Math.min(stretch.slots, slots.max);
}

export async function hostCapacity(
  repo: Repo,
  host: string,
  now: Date,
): Promise<number | null> {
  const active = await activeHostRevision(repo, host);
  if (active === null) return null;
  const events = planEvents(
    await repo.eventsWith("plan", { host, kind: "stretch" }),
  );
  return capacityOf(active.value.slots, stretchInForce(events, now));
}
