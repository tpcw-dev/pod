import type { ZodType } from "zod";
import {
  OrcaVersionUnsupported,
  supportedOrcaRange,
  type Receipt,
  type ReceiptRecord,
} from "../../core/ports/orca.ts";

function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function checkVersion(installed: string): string {
  const version = installed.trim();
  const got = parts(version);
  const min = parts(supportedOrcaRange.min);
  const below = parts(supportedOrcaRange.below);
  if (
    got === null ||
    min === null ||
    below === null ||
    compare(got, min) < 0 ||
    compare(got, below) >= 0
  )
    throw new OrcaVersionUnsupported(version);
  return version;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function receiptOf<T>(
  record: ReceiptRecord,
  schema: ZodType<T>,
): Receipt<T> {
  const raw = parseJson(record.stdout);
  let result: T | null = null;
  if (raw !== null && typeof raw === "object" && "result" in raw) {
    const parsed = schema.safeParse(raw.result);
    if (parsed.success) result = parsed.data;
  }
  return {
    verb: record.verb,
    exitCode: record.exitCode,
    result,
    raw: raw !== null && typeof raw === "object" ? raw : null,
    orcaVersion: record.orcaVersion,
  };
}
