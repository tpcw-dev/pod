import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrcaPort } from "../../src/core/ports/orca.ts";

export interface TempEntry {
  verb: string;
  argv?: string[];
  exitCode?: number;
  signal?: string | null;
  stdout?: string;
  result?: unknown;
}

export function ok(
  verb: string,
  result: unknown,
  argv: string[] = [],
): TempEntry {
  return { verb, argv, result };
}

export function lost(verb: string, argv: string[] = []): TempEntry {
  return { verb, argv, exitCode: 137, signal: "SIGKILL", stdout: "" };
}

export function unknownReply(
  verb: string,
  requestId: string,
  argv: string[] = [],
): TempEntry {
  return {
    verb,
    argv,
    exitCode: 1,
    stdout: JSON.stringify({
      ok: false,
      error: {
        code: "runtime_timeout",
        message: "timed out",
        data: {
          orchestrationRequestId: requestId,
          recovery: { disposition: "outcome_unknown" },
        },
      },
    }),
  };
}

export function fixtures(entries: readonly TempEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pod-fixtures-"));
  for (const [i, item] of entries.entries()) {
    const name = `${String(i + 1).padStart(3, "0")}-${item.verb}.json`;
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        verb: item.verb,
        match: { argv: item.argv ?? [] },
        exitCode: item.exitCode ?? 0,
        signal: item.signal ?? null,
        stdout:
          item.stdout ?? JSON.stringify({ ok: true, result: item.result }),
        stderr: "",
        orcaVersion: "1.4.211",
        recordedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
  }
  return dir;
}

export function noCalls(): OrcaPort {
  const refuse = () => Promise.reject(new Error("no Orca call expected"));
  return {
    version: () => Promise.resolve({ version: "1.4.211" }),
    runCreate: refuse,
    runUse: refuse,
    taskCreate: refuse,
    workerStart: refuse,
    workerStop: refuse,
    workerRelease: refuse,
    check: refuse,
    send: refuse,
    requestShow: refuse,
    workerList: refuse,
  };
}
