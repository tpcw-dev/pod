import { isDeepStrictEqual } from "node:util";
import type {
  TrackerPort,
  TrackerReceiptSink,
} from "../../core/ports/tracker.ts";
import { loadFixtures, matchVariables, type LoadedFixture } from "./fixture.ts";
import { trackerMethods } from "./methods.ts";

export class TrackerReplayMismatch extends Error {}

function subset(
  want: Record<string, unknown>,
  got: Record<string, unknown>,
): boolean {
  return Object.entries(want).every(([key, value]) =>
    isDeepStrictEqual(got[key], value),
  );
}

function expected(item: LoadedFixture | undefined): string {
  if (item === undefined) return "- expected nothing";
  const { method, match } = item.entry;
  return `- expected ${item.name.slice(0, 3)} ${method} ${match.operation} ${JSON.stringify(match.variables)}`;
}

export interface ReplayTracker extends TrackerPort {
  assertDone(): void;
}

export function makeReplayTracker(options: {
  dir: string;
  sink: TrackerReceiptSink;
  estimateScale: string;
}): ReplayTracker {
  const entries = loadFixtures(options.dir);
  let next = 0;
  const port = trackerMethods(async (verb, request) => {
    const variables = matchVariables(request.variables);
    const item = entries[next];
    if (
      item === undefined ||
      item.entry.method !== verb ||
      item.entry.match.operation !== request.operation ||
      !subset(item.entry.match.variables, variables)
    )
      throw new TrackerReplayMismatch(
        `${expected(item)}\n+ actual ${verb} ${request.operation} ${JSON.stringify(variables)}`,
      );
    next += 1;
    const { entry } = item;
    await options.sink({
      verb,
      operation: request.operation,
      variables: request.variables,
      status: entry.status,
      body: entry.body,
      error: entry.error,
      requestId: null,
      startedAt: entry.recordedAt,
      endedAt: entry.recordedAt,
    });
    return {
      status: entry.status,
      body: entry.body,
      error: entry.error,
      requestId: null,
    };
  }, options.estimateScale);
  return {
    ...port,
    assertDone() {
      const missing = entries.slice(next);
      if (missing.length > 0)
        throw new TrackerReplayMismatch(
          missing
            .map((item) => `${expected(item)}\n+ actual nothing`)
            .join("\n"),
        );
    },
  };
}
