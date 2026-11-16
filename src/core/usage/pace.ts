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

export function noHeadroom(value: string, pace: Pace | null): boolean {
  return pace === "avoid" || Number(value) >= 100;
}

export interface UsageReading {
  row: UsageObservation | undefined;
  headroom: Headroom;
}

interface Known {
  row: UsageObservation;
  headroom: Exclude<Headroom, "unknown">;
}

function highest(readings: readonly Known[]): Known | undefined {
  return readings.reduce<Known | undefined>(
    (best, each) =>
      best === undefined ||
      Number(each.headroom.value) > Number(best.headroom.value)
        ? each
        : best,
    undefined,
  );
}

export function worstWindow(
  rows: readonly UsageObservation[],
  limits: UsageLimits,
  now: Date,
): UsageReading {
  const newestFirst = [...rows].sort(
    (a, b) => b.observed_at.getTime() - a.observed_at.getTime() || b.id - a.id,
  );
  const known = newestFirst.flatMap((row): Known[] => {
    const headroom = readHeadroom(row, limits, now);
    return headroom === "unknown" ? [] : [{ row, headroom }];
  });
  return (
    highest(
      known.filter(({ headroom }) => noHeadroom(headroom.value, headroom.pace)),
    ) ??
    highest(known) ?? { row: newestFirst[0], headroom: "unknown" }
  );
}
