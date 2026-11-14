import { z } from "zod";
import type { UsageObservation } from "../domain/ledger.ts";
import { Pace, type UsageLimits } from "../domain/usage.ts";

export const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

export interface PaceWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: Date;
}

export function pace(window: PaceWindow, at: Date, floor: number): Pace {
  const left = window.resets_at.getTime() - at.getTime();
  if (left <= 0) return "ok";
  const length = window.window_minutes * minuteMs;
  const used = window.used_percent;
  if (length >= dayMs && left <= dayMs) return used < 100 ? "spend" : "ok";
  const ahead = used > (100 * (length - left)) / length && used > floor;
  return ahead ? "avoid" : "ok";
}

export type Headroom = "unknown" | { value: string; pace: Pace | null };

const Source = z.looseObject({ pace: Pace.nullable().catch(null) });

export function readHeadroom(
  row: UsageObservation | undefined,
  limits: UsageLimits,
  now: Date,
): Headroom {
  if (row === undefined || row.coverage === "no_source" || row.value === null)
    return "unknown";
  if (
    now.getTime() - row.observed_at.getTime() >
    limits.stale_minutes * minuteMs
  )
    return "unknown";
  return {
    value: row.value,
    pace: Source.catch({ pace: null }).parse(row.source).pace,
  };
}
