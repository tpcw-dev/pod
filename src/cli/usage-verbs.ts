import { readFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { singleActive } from "../core/config/active.ts";
import { hostTimeZone } from "../core/config/host.ts";
import { usageLimits } from "../core/config/limits.ts";
import { serviceKinds } from "../core/config/service-kinds.ts";
import { parseUsage } from "../core/domain/usage.ts";
import type { Repo } from "../core/ports/db.ts";
import { usageFacts } from "../core/usage/facts.ts";
import { recordUsage } from "../core/usage/record.ts";
import {
  dayOf,
  dayWindow,
  tokenTotal,
  usageDay,
  validTimeZone,
  type UsageDay,
  type UsageView,
} from "../core/usage/rollup.ts";
import { schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { readText } from "./yaml-file.ts";

export const UsageRecordInput = z.strictObject({
  args: z.tuple([z.string()]),
});
type UsageRecordInput = z.infer<typeof UsageRecordInput>;

const Pace = z.enum(["spend", "ok", "avoid"]).nullable();

export const UsageRecordOutput = z.object({
  units: z.number(),
  duplicates: z.number(),
  sessions: z.array(
    z.object({
      runtime: z.string(),
      session_id: z.string(),
      attribution: z.enum(["locator", "path", "unattributed"]).nullable(),
      dispatch_id: z.string().nullable(),
      run_id: z.string().nullable(),
      first_at: z.string().nullable(),
      through: z.string().nullable(),
      rows: z.number(),
      outcome: z.enum(["written", "replayed", "nothing_new"]),
    }),
  ),
  windows: z.array(
    z.object({
      runtime: z.string(),
      window: z.string(),
      observed_at: z.string(),
      pace: Pace,
      outcome: z.enum(["written", "replayed"]),
    }),
  ),
});
type UsageRecordOutput = z.infer<typeof UsageRecordOutput>;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError("cannot read stdin", [reason]);
  }
}

export async function usageRecordVerb(
  input: UsageRecordInput,
): Promise<UsageRecordOutput> {
  const [path] = input.args;
  const parsed = parseUsage(path === "-" ? readStdin() : readText(path));
  if (!parsed.ok)
    throw schemaError(`${path} fails the usage record format`, parsed.issues);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const policy = await singleActive(connection.db, "policy", "global", "");
    return await recordUsage(connection.db, {
      usage: parsed.input,
      limits: usageLimits(policy?.value),
      host: host.hostId,
      now: () => new Date(),
    });
  } finally {
    await connection.close();
  }
}

const Count = z.number().nullable();

const TokensJson = z.object({
  input: Count,
  cached_input: Count,
  cache_write: Count,
  output: Count,
  reasoning: Count,
});

const CostJson = z.object({
  basis: z.literal("list-price equivalent"),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  reason: z.enum(["unmeasured", "unpriced", "mixed_currency"]).nullable(),
});

const totals = {
  tokens: TokensJson,
  running_minutes: Count,
  wall_minutes: Count,
  cost: CostJson,
};

const PointRollupJson = z.object({
  runs: z.array(
    z.object({
      run_id: z.string(),
      project: z.string().nullable(),
      size: z.string().nullable(),
      points: Count,
      done_at: z.string(),
      tokens: Count,
      running_minutes: Count,
      wall_minutes: Count,
      cost: CostJson,
    }),
  ),
  points_done: z.number(),
  tokens_per_point: Count,
  minutes_per_point: Count,
  unknown: z.object({
    points: z.array(z.string()),
    tokens: z.array(z.string()),
    minutes: z.array(z.string()),
  }),
});

export const UsageDayJson = z.object({
  day: z.string().nullable(),
  time_zone: z.string(),
  since: z.string().nullable(),
  until: z.string().nullable(),
  project: z.string().nullable(),
  run: z.string().nullable(),
  seats: z.array(
    z.object({
      dispatch_id: z.string(),
      seat: z.string(),
      run_id: z.string(),
      settled_at: z.string().nullable(),
      ...totals,
    }),
  ),
  runs: z.array(
    z.object({
      run_id: z.string(),
      project: z.string().nullable(),
      seats: z.number(),
      ...totals,
    }),
  ),
  total: z.object(totals),
  points: PointRollupJson,
  projects: z.array(
    z.object({
      project: z.string().nullable(),
      ...totals,
      points: PointRollupJson,
    }),
  ),
  unattributed: z.array(
    z.object({
      runtime: z.string(),
      records: z.number(),
      tokens: TokensJson,
      cost: CostJson,
    }),
  ),
  coverage: z.object({
    tokens_source: z.object({
      locator: z.number(),
      path: z.number(),
      unattributed: z.number(),
    }),
    null_values: z.array(
      z.object({
        runtime: z.string(),
        session_id: z.string(),
        model: z.string().nullable(),
        fields: z.array(z.string()),
      }),
    ),
    no_record: z.array(z.string()),
    unknown_minutes: z.array(z.string()),
  }),
});

export const MeasurementUsageJson = z.object({
  ...totals,
  unknown: z.object({
    tokens: z.array(z.string()),
    minutes: z.array(z.string()),
  }),
});

export const UsageInput = z.strictObject({
  args: z.tuple([]),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((day) => {
      const date = new Date(`${day}T00:00:00Z`);
      return (
        !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day)
      );
    }, "is not a calendar day")
    .optional(),
  project: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  json: z.boolean().optional(),
});
type UsageInput = z.infer<typeof UsageInput>;

export const UsageOutput = UsageDayJson.extend({
  nextSteps: z.array(z.string()).optional(),
});
type UsageOutput = z.infer<typeof UsageOutput>;

export async function hostZone(
  db: Repo,
  host: string,
): Promise<{ zone: string; nextSteps: string[] }> {
  const zone = await hostTimeZone(db, host);
  if (zone === null) return { zone: "UTC", nextSteps: [] };
  if (validTimeZone(zone)) return { zone, nextSteps: [] };
  return {
    zone: "UTC",
    nextSteps: [
      `the host Revision's timezone ${zone} is not a time zone; usage days read UTC`,
    ],
  };
}

export async function readUsageDay(
  db: Repo,
  zone: string,
  view: UsageView,
  project: string | null,
): Promise<UsageDay> {
  const { estimateScale } = await serviceKinds(db);
  return usageDay(await usageFacts(db, view, zone, estimateScale), {
    project,
  });
}

export function todayView(zone: string, day?: string): UsageView {
  const date = day ?? dayOf(new Date(), zone);
  return { kind: "day", day: date, ...dayWindow(date, zone) };
}

export async function usageVerb(input: UsageInput): Promise<UsageOutput> {
  if (input.run !== undefined && input.day !== undefined)
    throw usageError("--run reports the Run's whole life and takes no --day");
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const { zone, nextSteps } = await hostZone(connection.db, host.hostId);
    const view: UsageView =
      input.run === undefined
        ? todayView(zone, input.day)
        : { kind: "run", run_id: input.run };
    const usage = await readUsageDay(
      connection.db,
      zone,
      view,
      input.project ?? null,
    );
    return UsageOutput.parse({
      ...usage,
      ...(nextSteps.length === 0 ? {} : { nextSteps }),
    });
  } finally {
    await connection.close();
  }
}

function shown(value: number | null): string {
  return value === null ? "unknown" : String(Math.round(value * 10) / 10);
}

function costText(cost: z.infer<typeof CostJson>): string {
  const amount =
    cost.amount === null
      ? `unknown (${cost.reason ?? "unpriced"})`
      : `${cost.amount.toFixed(4)} ${cost.currency ?? ""}`.trim();
  return `cost ${amount} list-price equivalent`;
}

function tokensText(t: z.infer<typeof TokensJson>): string {
  return `tokens ${shown(tokenTotal(t))} (input ${shown(t.input)}, cached ${shown(t.cached_input)}, cache write ${shown(t.cache_write)}, output ${shown(t.output)}, reasoning ${shown(t.reasoning)})`;
}

function totalsText(row: {
  tokens: z.infer<typeof TokensJson>;
  running_minutes: number | null;
  wall_minutes: number | null;
  cost: z.infer<typeof CostJson>;
}): string {
  return [
    tokensText(row.tokens),
    `running ${shown(row.running_minutes)} min`,
    `wall ${shown(row.wall_minutes)} min`,
    costText(row.cost),
  ].join(", ");
}

function pointsText(points: z.infer<typeof PointRollupJson>): string {
  return `points ${points.points_done}, tokens per point ${shown(points.tokens_per_point)}, minutes per point ${shown(points.minutes_per_point)}`;
}

export function renderUsage(output: UsageOutput): string {
  const head =
    output.day === null
      ? `usage for Run ${output.run ?? ""} (whole life)`
      : `usage for ${output.day} (${output.time_zone})`;
  const lines = [
    head,
    ...output.seats.map(
      (seat) =>
        `seat ${seat.dispatch_id} ${seat.seat} run ${seat.run_id}: ${totalsText(seat)}`,
    ),
    ...output.runs.map(
      (run) =>
        `run ${run.run_id} (${run.project ?? "no project"}, ${run.seats} seats): ${totalsText(run)}`,
    ),
    ...output.points.runs.map(
      (run) =>
        `point run ${run.run_id} ${run.size ?? "unknown"} = ${shown(run.points)} points: tokens ${shown(run.tokens)}, running ${shown(run.running_minutes)} min, ${costText(run.cost)}`,
    ),
    ...output.projects.map(
      (project) =>
        `project ${project.project ?? "no project"}: ${totalsText(project)}; ${pointsText(project.points)}`,
    ),
    `overall: ${totalsText(output.total)}; ${pointsText(output.points)}`,
    ...output.unattributed.map(
      (row) =>
        `unattributed ${row.runtime} (${row.records} records): ${tokensText(row.tokens)}, ${costText(row.cost)}`,
    ),
    `coverage: locator ${output.coverage.tokens_source.locator}, path ${output.coverage.tokens_source.path}, unattributed ${output.coverage.tokens_source.unattributed}; null values ${output.coverage.null_values.length}; no record ${output.coverage.no_record.join(" ") || "none"}; unknown minutes ${output.coverage.unknown_minutes.join(" ") || "none"}`,
    ...(output.nextSteps ?? []),
  ];
  return lines.join("\n");
}
