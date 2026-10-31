import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FixtureRefused, type Scrubber } from "../../core/domain/scrub.ts";
import type { DocsReceiptRecord } from "../../core/ports/docs.ts";
import { trimUsers } from "./scrub.ts";

export const DocsFixture = z.looseObject({
  method: z.string().min(1),
  page: z.string(),
  heading: z.string(),
  match: z.looseObject({
    method: z.literal("GET"),
    path: z.string().min(1),
    query: z.record(z.string(), z.string()),
  }),
  status: z.int().nullable(),
  body: z.string().nullable(),
  error: z.string().nullable(),
  recordedAt: z.string(),
});
export type DocsFixture = z.infer<typeof DocsFixture>;

export class DocsFixtureInvalid extends Error {
  constructor(readonly file: string) {
    super(`fixture ${file} is not JSON or fails the docs fixture schema`);
  }
}

export interface LoadedFixture {
  name: string;
  entry: DocsFixture;
}

function parseFixture(dir: string, name: string): DocsFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
  } catch {
    throw new DocsFixtureInvalid(name);
  }
  const parsed = DocsFixture.safeParse(raw);
  if (!parsed.success) throw new DocsFixtureInvalid(name);
  return parsed.data;
}

export function loadFixtures(dir: string): LoadedFixture[] {
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.json$/.test(name))
    .sort()
    .map((name) => ({ name, entry: parseFixture(dir, name) }));
}

function nextNumber(dir: string): number {
  let top = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d{3})-/.exec(name);
    if (match !== null) top = Math.max(top, Number(match[1]));
  }
  return top + 1;
}

export function writeDocsFixture(
  dir: string,
  record: DocsReceiptRecord,
  scrubber: Scrubber,
): string {
  const name = `${String(nextNumber(dir)).padStart(3, "0")}-${record.verb}.json`;
  const fixture: DocsFixture = {
    method: record.verb,
    page: record.page,
    heading: record.heading,
    match: { ...record.request },
    status: record.status,
    body: record.body === null ? null : trimUsers(record.body),
    error: record.error,
    recordedAt: record.endedAt,
  };
  const text = `${scrubber.scrub(JSON.stringify(fixture, null, 2))}\n`;
  const hits = scrubber.hits(text);
  if (hits.length > 0) throw new FixtureRefused(name, hits);
  writeFileSync(join(dir, name), text);
  return name;
}
