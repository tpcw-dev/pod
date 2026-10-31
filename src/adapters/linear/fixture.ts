import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FixtureRefused, type Scrubber } from "../../core/domain/scrub.ts";
import type { TrackerReceiptRecord } from "../../core/ports/tracker.ts";

export const TrackerFixture = z.looseObject({
  method: z.string().min(1),
  match: z.looseObject({
    operation: z.string().min(1),
    variables: z.record(z.string(), z.unknown()),
  }),
  status: z.int().nullable(),
  body: z.string().nullable(),
  error: z.string().nullable(),
  recordedAt: z.string(),
});
export type TrackerFixture = z.infer<typeof TrackerFixture>;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function matchVariables(
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const { body, ...rest } = variables;
  return typeof body === "string"
    ? { ...rest, bodyHash: sha256(body) }
    : variables;
}

export interface LoadedFixture {
  name: string;
  entry: TrackerFixture;
}

export function loadFixtures(dir: string): LoadedFixture[] {
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.json$/.test(name))
    .sort()
    .map((name) => ({
      name,
      entry: TrackerFixture.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      ),
    }));
}

function nextNumber(dir: string): number {
  let top = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d{3})-/.exec(name);
    if (match !== null) top = Math.max(top, Number(match[1]));
  }
  return top + 1;
}

export function writeTrackerFixture(
  dir: string,
  record: TrackerReceiptRecord,
  scrubber: Scrubber,
): string {
  const name = `${String(nextNumber(dir)).padStart(3, "0")}-${record.verb}.json`;
  const fixture: TrackerFixture = {
    method: record.verb,
    match: {
      operation: record.operation,
      variables: matchVariables(record.variables),
    },
    status: record.status,
    body: record.body,
    error: record.error,
    recordedAt: record.endedAt,
  };
  const text = `${scrubber.scrub(JSON.stringify(fixture, null, 2))}\n`;
  const hits = scrubber.hits(text);
  if (hits.length > 0) throw new FixtureRefused(name, hits);
  writeFileSync(join(dir, name), text);
  return name;
}
