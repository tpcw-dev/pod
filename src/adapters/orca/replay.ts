import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z, type ZodType } from "zod";
import { type OrcaPort, type ReceiptSink } from "../../core/ports/orca.ts";
import { verbOf } from "./argv.ts";
import { methods } from "./methods.ts";
import { checkVersion, receiptOf } from "./receipt.ts";

const FixtureEntry = z.looseObject({
  verb: z.string().min(1),
  match: z.looseObject({ argv: z.array(z.string()) }),
  exitCode: z.int(),
  signal: z.string().nullable().default(null),
  stdout: z.string(),
  stderr: z.string(),
  orcaVersion: z.string(),
  recordedAt: z.string(),
});
type FixtureEntry = z.infer<typeof FixtureEntry>;

export class ReplayMismatch extends Error {}

function isSubsequence(want: readonly string[], argv: readonly string[]) {
  let at = 0;
  for (const part of argv) if (part === want[at]) at += 1;
  return at === want.length;
}

interface Loaded {
  name: string;
  entry: FixtureEntry;
}

function load(dir: string): Loaded[] {
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.json$/.test(name))
    .sort()
    .map((name) => ({
      name,
      entry: FixtureEntry.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      ),
    }));
}

function expected(item: Loaded | undefined): string {
  if (item === undefined) return "- expected nothing";
  return `- expected ${item.name.slice(0, 3)} ${item.entry.verb} ${JSON.stringify(item.entry.match.argv)}`;
}

export interface ReplayOrca extends OrcaPort {
  assertDone(): void;
}

export function makeReplayOrca(options: {
  dir: string;
  sink: ReceiptSink;
}): ReplayOrca {
  const entries = load(options.dir);
  let next = 0;

  async function call<T>(argv: string[], schema: ZodType<T>) {
    const verb = verbOf(argv);
    const item = entries[next];
    if (
      item === undefined ||
      item.entry.verb !== verb ||
      !isSubsequence(item.entry.match.argv, argv)
    )
      throw new ReplayMismatch(
        `${expected(item)}\n+ actual ${verb} ${JSON.stringify(argv)}`,
      );
    next += 1;
    const { entry } = item;
    const record = {
      verb,
      argv,
      exitCode: entry.exitCode,
      signal: entry.signal,
      stdout: entry.stdout,
      stderr: entry.stderr,
      startedAt: entry.recordedAt,
      endedAt: entry.recordedAt,
      orcaVersion: checkVersion(entry.orcaVersion),
    };
    await options.sink(record);
    return receiptOf(record, schema);
  }

  return {
    version: () => {
      const first = entries[0];
      if (first === undefined)
        return Promise.reject(
          new ReplayMismatch(`no fixtures in ${options.dir}`),
        );
      return Promise.resolve({
        version: checkVersion(first.entry.orcaVersion),
      });
    },
    ...methods(call),
    assertDone() {
      const missing = entries.slice(next);
      if (missing.length > 0)
        throw new ReplayMismatch(
          missing
            .map((item) => `${expected(item)}\n+ actual nothing`)
            .join("\n"),
        );
    },
  };
}
