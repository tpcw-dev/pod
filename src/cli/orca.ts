import { mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { makeRealOrca } from "../adapters/orca/real.ts";
import { makeReplayOrca } from "../adapters/orca/replay.ts";
import { makeScrubber } from "../adapters/orca/scrub.ts";
import type { OrcaPort, ReceiptSink } from "../core/ports/orca.ts";
import { usageError } from "./errors.ts";

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function denylist(): string[] {
  const path = env("POD_SCRUB_DENYLIST");
  if (path === null)
    throw usageError("POD_ORCA_RECORD needs POD_SCRUB_DENYLIST", [
      "set POD_SCRUB_DENYLIST to the denylist file outside the repo",
    ]);
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    throw usageError("POD_SCRUB_DENYLIST names a file that cannot be read", [
      "set POD_SCRUB_DENYLIST to a readable denylist file",
    ]);
  }
}

export function orcaFor(sink: ReceiptSink): OrcaPort {
  const fixtures = env("POD_ORCA_FIXTURES");
  if (fixtures !== null) return makeReplayOrca({ dir: fixtures, sink });
  const dir = env("POD_ORCA_RECORD");
  if (dir === null) return makeRealOrca({ sink });
  const terms = denylist();
  mkdirSync(dir, { recursive: true });
  return makeRealOrca({
    sink,
    record: {
      dir,
      kill: env("POD_ORCA_RECORD_KILL"),
      scrubber: makeScrubber({
        hosts: [hostname()],
        users: [userInfo().username],
        roots: [process.cwd()],
        denylist: terms,
      }),
    },
  });
}
