import { mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { z } from "zod";
import { decode, fetchTransport } from "../adapters/linear/client.ts";
import { makeRealTracker } from "../adapters/linear/real.ts";
import { makeReplayTracker } from "../adapters/linear/replay.ts";
import { makeTrackerScrubber } from "../adapters/linear/scrub.ts";
import type { FixtureRefused } from "../core/domain/scrub.ts";
import type { TrackerPort, TrackerReceiptSink } from "../core/ports/tracker.ts";
import { usageError } from "./errors.ts";
import type { HostSettings } from "./host-profile.ts";

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function denylist(): string[] {
  const path = env("POD_SCRUB_DENYLIST");
  if (path === null)
    throw usageError("POD_TRACKER_RECORD needs POD_SCRUB_DENYLIST", [
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

export interface TrackerWiring {
  port: TrackerPort;
  recordRefusals(): readonly FixtureRefused[];
}

const Workspace = z.looseObject({ urlKey: z.string() });

async function workspaceKey(token: string): Promise<string[]> {
  const reply = await fetchTransport(token)(
    { operation: "Workspace", variables: {} },
    { drop: false },
  );
  const decoded = decode(reply, (data) => data["organization"], Workspace);
  if (decoded.result === null)
    throw usageError("POD_TRACKER_RECORD could not read the workspace key", [
      `tracker error ${decoded.error ?? "none"}`,
    ]);
  return [decoded.result.urlKey];
}

export async function trackerFor(
  sink: TrackerReceiptSink,
  host: HostSettings,
): Promise<TrackerWiring | null> {
  const scale = host.estimateScale;
  const fixtures = env("POD_TRACKER_FIXTURES");
  if (fixtures !== null)
    return {
      port: makeReplayTracker({ dir: fixtures, sink, estimateScale: scale }),
      recordRefusals: () => [],
    };
  const token = env(host.trackerTokenEnv);
  const dir = env("POD_TRACKER_RECORD");
  if (dir === null) {
    if (token === null) return null;
    return {
      port: makeRealTracker({
        sink,
        transport: fetchTransport(token),
        estimateScale: scale,
      }),
      recordRefusals: () => [],
    };
  }
  const terms = denylist();
  if (token === null)
    throw usageError(`POD_TRACKER_RECORD needs ${host.trackerTokenEnv}`, [
      `set ${host.trackerTokenEnv} to the tracker token`,
    ]);
  mkdirSync(dir, { recursive: true });
  const port = makeRealTracker({
    sink,
    transport: fetchTransport(token),
    estimateScale: scale,
    record: {
      dir,
      kill: env("POD_TRACKER_RECORD_KILL"),
      scrubber: makeTrackerScrubber({
        hosts: [hostname(), host.hostId],
        users: [userInfo().username],
        roots: [process.cwd()],
        workspace: await workspaceKey(token),
        denylist: terms,
      }),
    },
  });
  return { port, recordRefusals: () => port.recordRefusals() };
}
