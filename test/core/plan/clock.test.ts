import { expect, test } from "vitest";
import {
  dayEnd,
  hostDay,
  isDay,
  isTimezone,
} from "../../../src/core/plan/clock.ts";

const zone = "America/Los_Angeles";

test("the host's day turns at local midnight", () => {
  expect(hostDay(new Date("2026-11-15T07:59:59.000Z"), zone)).toBe(
    "2026-11-14",
  );
  expect(hostDay(new Date("2026-11-15T08:00:00.000Z"), zone)).toBe(
    "2026-11-15",
  );
  expect(hostDay(new Date("2026-11-14T16:00:00.000Z"), "Asia/Taipei")).toBe(
    "2026-11-15",
  );
});

test("a day ends at the next local midnight across both DST changes", () => {
  expect(dayEnd("2026-11-14", zone).toISOString()).toBe(
    "2026-11-15T08:00:00.000Z",
  );
  expect(dayEnd("2026-03-07", zone).toISOString()).toBe(
    "2026-03-08T08:00:00.000Z",
  );
  expect(dayEnd("2026-03-08", zone).toISOString()).toBe(
    "2026-03-09T07:00:00.000Z",
  );
  expect(dayEnd("2026-10-31", zone).toISOString()).toBe(
    "2026-11-01T07:00:00.000Z",
  );
  expect(dayEnd("2026-11-01", zone).toISOString()).toBe(
    "2026-11-02T08:00:00.000Z",
  );
});

test("a day is a real YYYY-MM-DD date", () => {
  expect(isDay("2026-02-28")).toBe(true);
  expect(isDay("2026-02-30")).toBe(false);
  expect(isDay("2026-2-28")).toBe(false);
  expect(isDay("tomorrow")).toBe(false);
});

test("a timezone is a name in Intl.supportedValuesOf", () => {
  expect(isTimezone("America/New_York")).toBe(true);
  expect(isTimezone("Asia/Taipei")).toBe(true);
  for (const name of ["Etc/UTC", "UTC", "+08:00", "Mars/Olympus_Mons"])
    expect(isTimezone(name)).toBe(false);
});
