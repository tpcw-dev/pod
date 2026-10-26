import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { ZodType } from "zod";
import {
  type OrcaPort,
  type ReceiptRecord,
  type ReceiptSink,
} from "../../core/ports/orca.ts";
import { matchArgv } from "./argv.ts";
import { methods } from "./methods.ts";
import { checkVersion, receiptOf } from "./receipt.ts";
import { writeFixture, type Scrubber } from "./scrub.ts";

export interface RunOutput {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

export type Runner = (
  file: string,
  args: readonly string[],
  opts: { killAfterMs: number | null },
) => Promise<RunOutput>;

export const recordKillAfterMs = 1500;

export const spawnRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: string | null = null;
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const timer =
      opts.killAfterMs === null
        ? null
        : setTimeout(() => child.kill("SIGKILL"), opts.killAfterMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finish = (code: number | null, signal: string | null) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, spawnError });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", finish);
  });

export interface RecordOptions {
  dir: string;
  kill: string | null;
  scrubber: Scrubber;
}

export interface RealOrcaOptions {
  sink: ReceiptSink;
  run?: Runner;
  executable?: string;
  record?: RecordOptions | null;
}

function exitCodeOf(output: RunOutput): number {
  if (output.spawnError !== null) return 127;
  if (output.code !== null) return output.code;
  const signo =
    output.signal === null
      ? undefined
      : constants.signals[output.signal as NodeJS.Signals];
  return 128 + (signo ?? 0);
}

export function makeRealOrca(options: RealOrcaOptions): OrcaPort {
  const run = options.run ?? spawnRunner;
  const file = options.executable ?? "orca";
  const record = options.record ?? null;
  let version: Promise<string> | null = null;

  const installed = (): Promise<string> => {
    version ??= run(file, ["--version"], { killAfterMs: null }).then((output) =>
      checkVersion(output.stdout),
    );
    return version;
  };

  async function call<T>(argv: string[], schema: ZodType<T>) {
    const orcaVersion = await installed();
    const verb = argv[1] ?? "";
    const startedAt = new Date().toISOString();
    const output = await run(file, argv, {
      killAfterMs:
        record !== null && record.kill === verb ? recordKillAfterMs : null,
    });
    const receipt: ReceiptRecord = {
      verb,
      argv,
      exitCode: exitCodeOf(output),
      signal: output.signal,
      stdout: output.stdout,
      stderr: output.spawnError ?? output.stderr,
      startedAt,
      endedAt: new Date().toISOString(),
      orcaVersion,
    };
    await options.sink(receipt);
    if (record !== null)
      writeFixture(record.dir, receipt, matchArgv(argv), record.scrubber);
    return receiptOf(receipt, schema);
  }

  return {
    version: async () => ({ version: await installed() }),
    ...methods(call),
  };
}
