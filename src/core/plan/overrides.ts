import type { Event } from "../domain/ledger.ts";
import {
  PlanPayload,
  type HoldPayload,
  type OrderPayload,
  type PriorityPayload,
  type PublishedPayload,
} from "../domain/plan.ts";

export interface PlanEvent {
  id: number;
  ts: Date;
  op_key: string | null;
  payload: PlanPayload;
}

interface Stamp {
  event_id: number;
  ts: string;
}

type Expiring<T> = Stamp & Omit<T, "kind" | "host" | "day">;

export type HoldInForce = Expiring<HoldPayload>;
export type PriorityInForce = Expiring<PriorityPayload>;
export type OrderInForce = Expiring<OrderPayload>;

export interface InForce {
  holds: HoldInForce[];
  priority: PriorityInForce | null;
  order: OrderInForce | null;
}

export interface PublishedRead extends Stamp {
  op_key: string;
  actor: string;
  ranked: PublishedPayload["ranked"];
  held: PublishedPayload["held"];
  inputs: PublishedPayload["inputs"];
}

export function newestOf(
  events: readonly PlanEvent[],
  matches: (each: PlanEvent) => boolean,
): PlanEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const each = events[index];
    if (each !== undefined && matches(each)) return each;
  }
  return undefined;
}

export function planEvents(events: readonly Event[]): PlanEvent[] {
  return events.flatMap((each) => {
    const parsed = PlanPayload.safeParse(each.payload);
    return parsed.success
      ? [
          {
            id: each.id,
            ts: each.ts,
            op_key: each.op_key,
            payload: parsed.data,
          },
        ]
      : [];
  });
}

function stamped(
  each: PlanEvent,
  payload: { actor: string; until: string | null; expires_at: string },
) {
  return {
    event_id: each.id,
    ts: each.ts.toISOString(),
    actor: payload.actor,
    until: payload.until,
    expires_at: payload.expires_at,
  };
}

function live<T extends { expires_at: string }>(
  payload: T | null,
  now: Date,
): T | null {
  return payload !== null && new Date(payload.expires_at) > now
    ? payload
    : null;
}

export function inForce(events: readonly PlanEvent[], now: Date): InForce {
  const holds = new Map<string, HoldInForce | null>();
  let priority: PriorityInForce | null = null;
  let order: OrderInForce | null = null;
  for (const each of events) {
    const payload = each.payload;
    if (payload.kind === "hold")
      holds.set(payload.key, {
        ...stamped(each, payload),
        key: payload.key,
        reason: payload.reason,
      });
    if (payload.kind === "release") holds.set(payload.key, null);
    if (payload.kind === "priority")
      priority = { ...stamped(each, payload), projects: payload.projects };
    if (payload.kind === "order")
      order = { ...stamped(each, payload), keys: payload.keys };
  }
  return {
    holds: [...holds.values()].flatMap((hold) => {
      const held = live(hold, now);
      return held === null ? [] : [held];
    }),
    priority: live(priority, now),
    order: live(order, now),
  };
}

export function overrideIds(overrides: InForce): number[] {
  return [
    ...overrides.holds,
    ...(overrides.priority === null ? [] : [overrides.priority]),
    ...(overrides.order === null ? [] : [overrides.order]),
  ]
    .map((each) => each.event_id)
    .sort((a, b) => a - b);
}

export function newestPublished(
  events: readonly PlanEvent[],
  day: string,
): PublishedRead | null {
  const found = newestOf(
    events,
    (each) => each.payload.kind === "published" && each.payload.day === day,
  );
  if (found === undefined || found.payload.kind !== "published") return null;
  const { actor, ranked, held, inputs } = found.payload;
  return {
    event_id: found.id,
    ts: found.ts.toISOString(),
    op_key: found.op_key ?? "",
    actor,
    ranked,
    held,
    inputs,
  };
}
