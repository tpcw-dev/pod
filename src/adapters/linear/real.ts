import { FixtureRefused, type Scrubber } from "../../core/domain/scrub.ts";
import type {
  TrackerPort,
  TrackerReceiptRecord,
  TrackerReceiptSink,
} from "../../core/ports/tracker.ts";
import type { Transport } from "./client.ts";
import { writeTrackerFixture } from "./fixture.ts";
import { trackerMethods } from "./methods.ts";

export interface TrackerRecordOptions {
  dir: string;
  kill: string | null;
  scrubber: Scrubber;
}

export interface RealTrackerOptions {
  sink: TrackerReceiptSink;
  transport: Transport;
  estimateScale: string;
  record?: TrackerRecordOptions | null;
}

export interface RealTracker extends TrackerPort {
  recordRefusals(): readonly FixtureRefused[];
}

export function makeRealTracker(options: RealTrackerOptions): RealTracker {
  const record = options.record ?? null;
  const refusals: FixtureRefused[] = [];
  const port = trackerMethods(async (verb, request) => {
    const startedAt = new Date().toISOString();
    const reply = await options.transport(request, {
      drop: record !== null && record.kill === verb,
    });
    const receipt: TrackerReceiptRecord = {
      verb,
      operation: request.operation,
      variables: request.variables,
      status: reply.status,
      body: reply.body,
      error: reply.error,
      requestId: reply.requestId,
      startedAt,
      endedAt: new Date().toISOString(),
    };
    await options.sink(receipt);
    if (record !== null) {
      try {
        writeTrackerFixture(record.dir, receipt, record.scrubber);
      } catch (error) {
        if (!(error instanceof FixtureRefused)) throw error;
        refusals.push(error);
      }
    }
    return reply;
  }, options.estimateScale);
  return { ...port, recordRefusals: () => refusals };
}
