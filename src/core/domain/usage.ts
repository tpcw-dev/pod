import { z } from "zod";

const Stamp = z.iso
  .datetime({ offset: true })
  .transform((text) => new Date(text));
const Count = z.int().min(0).nullable();
const Name = z.string().min(1);

export const tokenFields = [
  "input",
  "cached_input",
  "cache_write",
  "output",
  "reasoning",
  "calls",
] as const;
export type TokenField = (typeof tokenFields)[number];

const UnitRow = z.strictObject({
  type: z.literal("unit"),
  runtime: Name,
  session_id: Name,
  key: Name,
  at: Stamp,
  model: Name.nullable(),
  cwd: z.string().startsWith("/").nullable(),
  input: Count,
  cached_input: Count,
  cache_write: Count,
  output: Count,
  reasoning: Count,
  calls: Count,
});
export type UnitRow = z.infer<typeof UnitRow>;

const WindowRow = z.strictObject({
  type: z.literal("window"),
  runtime: Name,
  window: Name,
  used_percent: z.number().finite().min(0).nullable(),
  window_minutes: z.int().positive(),
  resets_at: Stamp,
  observed_at: Stamp,
});
export type WindowRow = z.infer<typeof WindowRow>;

const UsageLine = z.discriminatedUnion("type", [UnitRow, WindowRow]);

export interface UsageInput {
  units: UnitRow[];
  windows: WindowRow[];
}

function lineIssues(line: number, error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map(String).join(".");
    const at = path === "" ? `line ${line}` : `line ${line} ${path}`;
    return issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => `line ${line} ${key}: unknown key`)
      : [`${at}: ${issue.message}`];
  });
}

export function parseUsage(
  text: string,
): { ok: true; input: UsageInput } | { ok: false; issues: string[] } {
  const input: UsageInput = { units: [], windows: [] };
  const issues: string[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      issues.push(`line ${line}: not a JSON object`);
      return;
    }
    const parsed = UsageLine.safeParse(value);
    if (!parsed.success) {
      issues.push(...lineIssues(line, parsed.error));
      return;
    }
    if (parsed.data.type === "unit") input.units.push(parsed.data);
    else input.windows.push(parsed.data);
  });
  return issues.length === 0 ? { ok: true, input } : { ok: false, issues };
}

export const Attribution = z.enum(["locator", "path", "unattributed"]);
export type Attribution = z.infer<typeof Attribution>;

export const RecordCoverage = z.enum(["measured", "partial"]);
export type RecordCoverage = z.infer<typeof RecordCoverage>;

export const Pace = z.enum(["spend", "ok", "avoid"]);
export type Pace = z.infer<typeof Pace>;

export interface NewUsageRecord {
  runtime: string;
  session_id: string;
  model: string | null;
  input: number | null;
  cached_input: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
  calls: number | null;
  first_at: Date;
  through: Date;
  dispatch_id: string | null;
  run_id: string | null;
  attribution: Attribution;
  coverage: RecordCoverage;
  op_key: string;
  created_at: Date;
}

export interface UsageRecord extends NewUsageRecord {
  id: number;
}

export interface UsageLimits {
  floor_percent: number;
  stale_minutes: number;
}
