const zones = new Set(Intl.supportedValuesOf("timeZone"));

export function isTimezone(name: string): boolean {
  return zones.has(name);
}

function wallClock(at: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"],
    parts["hour"],
    parts["minute"],
    parts["second"],
  );
}

function offsetAt(at: number, timezone: string): number {
  return wallClock(at, timezone) - Math.floor(at / 1000) * 1000;
}

export function hostDay(now: Date, timezone: string): string {
  return new Date(wallClock(now.getTime(), timezone))
    .toISOString()
    .slice(0, 10);
}

export function isDay(text: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(text) &&
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text
  );
}

export function dayEnd(day: string, timezone: string): Date {
  const midnight = new Date(`${day}T00:00:00Z`);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  const wall = midnight.getTime();
  const first = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(first, timezone));
}
