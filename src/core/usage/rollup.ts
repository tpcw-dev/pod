import type { Dispatch, Size } from "../domain/ledger.ts";
import type { UsageRecord } from "../domain/usage.ts";
import type { Cost } from "./cost.ts";
import type { Minutes } from "./minutes.ts";

export const tokenClasses = [
  "input",
  "cached_input",
  "cache_write",
  "output",
  "reasoning",
] as const;
type TokenClass = (typeof tokenClasses)[number];
export type Tokens = Record<TokenClass, number | null>;

const pricedClasses = [
  "input",
  "cached_input",
  "cache_write",
  "output",
] as const;

export type CostReason = "unmeasured" | "unpriced" | "mixed_currency";

export interface CostSum {
  basis: "list-price equivalent";
  amount: number | null;
  currency: string | null;
  reason: CostReason | null;
}

export interface PricedRecord {
  record: UsageRecord;
  price: Cost;
}

export interface SeatFact {
  dispatch: Pick<Dispatch, "dispatch_id" | "seat" | "run_id" | "settled_at">;
  minutes: Minutes;
}

export interface RunFact {
  run_id: string;
  project: string | null;
  size: Size | null;
  points: number | null;
}

export interface DoneRun {
  run_id: string;
  done_at: Date;
  seats: SeatFact[];
  records: PricedRecord[];
}

export type UsageView =
  | { kind: "day"; day: string; since: Date; until: Date }
  | { kind: "run"; run_id: string };

export interface UsageFacts {
  view: UsageView;
  time_zone: string;
  runs: RunFact[];
  seats: SeatFact[];
  records: PricedRecord[];
  done: DoneRun[];
}

interface Totals {
  tokens: Tokens;
  running_minutes: number | null;
  wall_minutes: number | null;
  cost: CostSum;
}

export interface PointRollup {
  runs: ({
    run_id: string;
    project: string | null;
    size: Size | null;
    points: number | null;
    done_at: string;
    tokens: number | null;
  } & Omit<Totals, "tokens">)[];
  points_done: number;
  tokens_per_point: number | null;
  minutes_per_point: number | null;
  unknown: { points: string[]; tokens: string[]; minutes: string[] };
}

export interface UsageDay {
  day: string | null;
  time_zone: string;
  since: string | null;
  until: string | null;
  project: string | null;
  run: string | null;
  seats: ({
    dispatch_id: string;
    seat: string;
    run_id: string;
    settled_at: string | null;
  } & Totals)[];
  runs: ({ run_id: string; project: string | null; seats: number } & Totals)[];
  total: Totals;
  points: PointRollup;
  projects: ({ project: string | null; points: PointRollup } & Totals)[];
  unattributed: {
    runtime: string;
    records: number;
    tokens: Tokens;
    cost: CostSum;
  }[];
  coverage: {
    tokens_source: { locator: number; path: number; unattributed: number };
    null_values: {
      runtime: string;
      session_id: string;
      model: string | null;
      fields: string[];
    }[];
    no_record: string[];
    unknown_minutes: string[];
  };
}

export interface RunUsage extends Totals {
  unknown: { tokens: string[]; minutes: string[] };
}

const basis = "list-price equivalent";

function parts(at: Date, timeZone: string): Record<string, number> {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  return Object.fromEntries(
    fields
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function dayOf(at: Date, timeZone: string): string {
  const { year, month, day } = parts(at, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function offsetMs(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const local = Date.UTC(
    p["year"] ?? 0,
    (p["month"] ?? 1) - 1,
    p["day"] ?? 1,
    p["hour"] ?? 0,
    p["minute"] ?? 0,
    p["second"] ?? 0,
  );
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

function midnight(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

export function dayWindow(
  day: string,
  timeZone: string,
): { since: Date; until: Date } {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    since: midnight(day, timeZone),
    until: midnight(next.toISOString().slice(0, 10), timeZone),
  };
}

function sum(
  values: readonly (number | null)[],
  empty: number | null,
): number | null {
  if (values.length === 0) return empty;
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

const unknownTokens: Tokens = {
  input: null,
  cached_input: null,
  cache_write: null,
  output: null,
  reasoning: null,
};

function sumTokens(rows: readonly Tokens[], empty: number | null): Tokens {
  return Object.fromEntries(
    tokenClasses.map((name) => [
      name,
      sum(
        rows.map((row) => row[name]),
        empty,
      ),
    ]),
  ) as Tokens;
}

function tokensOf(record: UsageRecord): Tokens {
  return Object.fromEntries(
    tokenClasses.map((name) => [name, record[name]]),
  ) as Tokens;
}

export function tokenTotal(tokens: Tokens): number | null {
  return sum(
    tokenClasses.map((name) => tokens[name]),
    null,
  );
}

function nullFields(record: UsageRecord): string[] {
  return tokenClasses.filter((name) => record[name] === null);
}

export function recordCost(record: UsageRecord, price: Cost): CostSum {
  if (pricedClasses.some((name) => record[name] === null))
    return { basis, amount: null, currency: null, reason: "unmeasured" };
  return {
    basis,
    amount: price.cost,
    currency: price.currency,
    reason: price.reason,
  };
}

const reasonOrder: readonly CostReason[] = ["unmeasured", "unpriced"];

function sumCosts(rows: readonly CostSum[], empty: CostSum): CostSum {
  if (rows.length === 0) return empty;
  const missing = reasonOrder.find((reason) =>
    rows.some((row) => row.amount === null && row.reason === reason),
  );
  if (missing !== undefined || rows.some((row) => row.amount === null))
    return {
      basis,
      amount: null,
      currency: null,
      reason: missing ?? "mixed_currency",
    };
  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.size > 1)
    return { basis, amount: null, currency: null, reason: "mixed_currency" };
  return {
    basis,
    amount: rows.reduce((total, row) => total + (row.amount ?? 0), 0),
    currency: rows[0]?.currency ?? null,
    reason: null,
  };
}

const unmeasured: CostSum = {
  basis,
  amount: null,
  currency: null,
  reason: "unmeasured",
};
const nothing: CostSum = { basis, amount: 0, currency: null, reason: null };

function seatTotals(seat: SeatFact, records: readonly PricedRecord[]): Totals {
  const own = records.filter(
    ({ record }) => record.dispatch_id === seat.dispatch.dispatch_id,
  );
  return {
    tokens:
      own.length === 0
        ? unknownTokens
        : sumTokens(
            own.map(({ record }) => tokensOf(record)),
            null,
          ),
    running_minutes: seat.minutes.running_minutes,
    wall_minutes: seat.minutes.wall_minutes,
    cost:
      own.length === 0
        ? unmeasured
        : sumCosts(
            own.map(({ record, price }) => recordCost(record, price)),
            unmeasured,
          ),
  };
}

function runTotals(
  seats: readonly SeatFact[],
  records: readonly PricedRecord[],
  runId: string,
): Totals {
  const own = seats.filter((seat) => seat.dispatch.run_id === runId);
  const paths = records.filter(
    ({ record }) => record.attribution === "path" && record.run_id === runId,
  );
  const seatRows = own.map((seat) => seatTotals(seat, records));
  const pathCosts = paths.map(({ record, price }) => recordCost(record, price));
  const pathTokens = paths.map(({ record }) => tokensOf(record));
  return {
    tokens: sumTokens(
      [...seatRows.map((row) => row.tokens), ...pathTokens],
      null,
    ),
    running_minutes: sum(
      seatRows.map((row) => row.running_minutes),
      null,
    ),
    wall_minutes: sum(
      seatRows.map((row) => row.wall_minutes),
      null,
    ),
    cost: sumCosts(
      [...seatRows.map((row) => row.cost), ...pathCosts],
      unmeasured,
    ),
  };
}

function aggregate(rows: readonly Totals[]): Totals {
  return {
    tokens: sumTokens(
      rows.map((row) => row.tokens),
      0,
    ),
    running_minutes: sum(
      rows.map((row) => row.running_minutes),
      0,
    ),
    wall_minutes: sum(
      rows.map((row) => row.wall_minutes),
      0,
    ),
    cost: sumCosts(
      rows.map((row) => row.cost),
      nothing,
    ),
  };
}

function ratio(
  numerator: number,
  denominator: number,
  places: number,
): number | null {
  if (denominator === 0) return null;
  const scale = 10 ** places;
  return Math.round((numerator / denominator) * scale) / scale;
}

function pointRollup(
  done: readonly DoneRun[],
  runs: ReadonlyMap<string, RunFact>,
): PointRollup {
  const rows = done.map((item) => {
    const fact = runs.get(item.run_id);
    const totals = runTotals(item.seats, item.records, item.run_id);
    return {
      run_id: item.run_id,
      project: fact?.project ?? null,
      size: fact?.size ?? null,
      points: fact?.points ?? null,
      done_at: item.done_at.toISOString(),
      tokens: tokenTotal(totals.tokens),
      running_minutes: totals.running_minutes,
      wall_minutes: totals.wall_minutes,
      cost: totals.cost,
    };
  });
  const pointed = rows.flatMap((row) =>
    row.points === null ? [] : [{ ...row, points: row.points }],
  );
  const tokened = pointed.flatMap((row) =>
    row.tokens === null ? [] : [{ ...row, tokens: row.tokens }],
  );
  const timed = pointed.flatMap((row) =>
    row.running_minutes === null
      ? []
      : [{ ...row, running_minutes: row.running_minutes }],
  );
  const points = (list: readonly { points: number }[]) =>
    list.reduce((total, row) => total + row.points, 0);
  return {
    runs: rows,
    points_done: points(pointed),
    tokens_per_point: ratio(
      tokened.reduce((total, row) => total + row.tokens, 0),
      points(tokened),
      0,
    ),
    minutes_per_point: ratio(
      timed.reduce((total, row) => total + row.running_minutes, 0),
      points(timed),
      1,
    ),
    unknown: {
      points: rows
        .filter((row) => row.points === null)
        .map((row) => row.run_id),
      tokens: rows
        .filter((row) => row.tokens === null)
        .map((row) => row.run_id),
      minutes: rows
        .filter((row) => row.running_minutes === null)
        .map((row) => row.run_id),
    },
  };
}

function byName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

export function usageDay(
  facts: UsageFacts,
  filter: { project: string | null },
): UsageDay {
  const runs = new Map(facts.runs.map((run) => [run.run_id, run]));
  const runView = facts.view.kind === "run";
  const narrowed = runView || filter.project !== null;
  const kept = (runId: string) =>
    filter.project === null || runs.get(runId)?.project === filter.project;
  const seats = facts.seats
    .filter((seat) => kept(seat.dispatch.run_id))
    .sort((a, b) => byName(a.dispatch.dispatch_id, b.dispatch.dispatch_id));
  const seatRun = new Map(
    seats.map((seat) => [seat.dispatch.dispatch_id, seat.dispatch.run_id]),
  );
  const records = facts.records.filter(({ record }) => {
    if (record.attribution === "unattributed") return !narrowed;
    if (record.attribution === "path")
      return record.run_id !== null && kept(record.run_id);
    return record.dispatch_id !== null && seatRun.has(record.dispatch_id);
  });
  const done = facts.done.filter((item) => kept(item.run_id));
  const runIds = [
    ...new Set([
      ...seats.map((seat) => seat.dispatch.run_id),
      ...records.flatMap(({ record }) =>
        record.attribution === "path" && record.run_id !== null
          ? [record.run_id]
          : [],
      ),
    ]),
  ].sort(byName);
  const runRows = runIds.map((runId) => ({
    run_id: runId,
    project: runs.get(runId)?.project ?? null,
    seats: seats.filter((seat) => seat.dispatch.run_id === runId).length,
    ...runTotals(seats, records, runId),
  }));
  const projectNames = [
    ...new Set([
      ...runRows.map((row) => row.project),
      ...done.map((item) => runs.get(item.run_id)?.project ?? null),
    ]),
  ].sort(byName);
  const unattributed = records.filter(
    ({ record }) => record.attribution === "unattributed",
  );
  const runtimes = [
    ...new Set(unattributed.map(({ record }) => record.runtime)),
  ].sort(byName);
  const view = facts.view;
  return {
    day: view.kind === "day" ? view.day : null,
    time_zone: facts.time_zone,
    since: view.kind === "day" ? view.since.toISOString() : null,
    until: view.kind === "day" ? view.until.toISOString() : null,
    project: filter.project,
    run: view.kind === "run" ? view.run_id : null,
    seats: seats.map((seat) => ({
      dispatch_id: seat.dispatch.dispatch_id,
      seat: seat.dispatch.seat,
      run_id: seat.dispatch.run_id,
      settled_at: seat.dispatch.settled_at?.toISOString() ?? null,
      ...seatTotals(seat, records),
    })),
    runs: runRows,
    total: aggregate(runRows),
    points: pointRollup(done, runs),
    projects: projectNames.map((project) => ({
      project,
      ...aggregate(runRows.filter((row) => row.project === project)),
      points: pointRollup(
        done.filter(
          (item) => (runs.get(item.run_id)?.project ?? null) === project,
        ),
        runs,
      ),
    })),
    unattributed: runtimes.map((runtime) => {
      const own = unattributed.filter(
        ({ record }) => record.runtime === runtime,
      );
      return {
        runtime,
        records: own.length,
        tokens: sumTokens(
          own.map(({ record }) => tokensOf(record)),
          null,
        ),
        cost: sumCosts(
          own.map(({ record, price }) => recordCost(record, price)),
          unmeasured,
        ),
      };
    }),
    coverage: {
      tokens_source: {
        locator: records.filter(
          ({ record }) => record.attribution === "locator",
        ).length,
        path: records.filter(({ record }) => record.attribution === "path")
          .length,
        unattributed: unattributed.length,
      },
      null_values: records.flatMap(({ record }) => {
        const fields = nullFields(record);
        return fields.length === 0
          ? []
          : [
              {
                runtime: record.runtime,
                session_id: record.session_id,
                model: record.model,
                fields,
              },
            ];
      }),
      no_record: seats
        .filter(
          (seat) =>
            !records.some(
              ({ record }) => record.dispatch_id === seat.dispatch.dispatch_id,
            ),
        )
        .map((seat) => seat.dispatch.dispatch_id),
      unknown_minutes: seats
        .filter(
          (seat) =>
            seat.minutes.running_minutes === null ||
            seat.minutes.wall_minutes === null,
        )
        .map((seat) => seat.dispatch.dispatch_id),
    },
  };
}

export function runUsage(
  runId: string,
  seats: readonly SeatFact[],
  records: readonly PricedRecord[],
): RunUsage {
  const unknownTokenSeats = seats
    .filter((seat) => {
      const own = records.filter(
        ({ record }) => record.dispatch_id === seat.dispatch.dispatch_id,
      );
      return (
        own.length === 0 ||
        own.some(({ record }) => nullFields(record).length > 0)
      );
    })
    .map((seat) => seat.dispatch.dispatch_id);
  const unknownPaths = records
    .filter(
      ({ record }) =>
        record.attribution === "path" && nullFields(record).length > 0,
    )
    .map(({ record }) => `session:${record.session_id}`);
  return {
    ...runTotals(seats, records, runId),
    unknown: {
      tokens: [...unknownTokenSeats, ...unknownPaths],
      minutes: seats
        .filter(
          (seat) =>
            seat.minutes.running_minutes === null ||
            seat.minutes.wall_minutes === null,
        )
        .map((seat) => seat.dispatch.dispatch_id),
    },
  };
}
