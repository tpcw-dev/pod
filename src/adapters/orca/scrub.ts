import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureRefused, type Scrubber } from "../../core/domain/scrub.ts";
import type { ReceiptRecord } from "../../core/ports/orca.ts";

export {
  FixtureRefused,
  makeScrubber,
  type ScrubTerms,
  type Scrubber,
} from "../../core/domain/scrub.ts";

function nextNumber(dir: string): number {
  let top = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d{3})-/.exec(name);
    if (match !== null) top = Math.max(top, Number(match[1]));
  }
  return top + 1;
}

const blankedTerminalFields = ["title", "branch", "preview"] as const;

export function blankTerminalFields(verb: string, stdout: string): string {
  if (verb !== "terminal-show") return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const terminal = (
    parsed as { result?: { terminal?: Record<string, unknown> } }
  ).result?.terminal;
  if (terminal === undefined) return stdout;
  for (const field of blankedTerminalFields)
    if (field in terminal) terminal[field] = "";
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function writeFixture(
  dir: string,
  record: ReceiptRecord,
  match: readonly string[],
  scrubber: Scrubber,
): string {
  const name = `${String(nextNumber(dir)).padStart(3, "0")}-${record.verb}.json`;
  const fixture = {
    verb: record.verb,
    match: { argv: match },
    exitCode: record.exitCode,
    signal: record.signal,
    stdout: blankTerminalFields(record.verb, record.stdout),
    stderr: record.stderr,
    orcaVersion: record.orcaVersion,
    recordedAt: record.endedAt,
  };
  const text = `${scrubber.scrub(JSON.stringify(fixture, null, 2))}\n`;
  const hits = scrubber.hits(text);
  if (hits.length > 0) throw new FixtureRefused(name, hits);
  writeFileSync(join(dir, name), text);
  return name;
}
