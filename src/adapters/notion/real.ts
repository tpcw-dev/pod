import { FixtureRefused, type Scrubber } from "../../core/domain/scrub.ts";
import type {
  DocsPort,
  DocsReceiptRecord,
  DocsReceiptSink,
} from "../../core/ports/docs.ts";
import type { Transport } from "./client.ts";
import { writeDocsFixture } from "./fixture.ts";
import { docsMethods } from "./methods.ts";

export interface DocsRecordOptions {
  dir: string;
  scrubber: Scrubber;
}

export interface RealDocsOptions {
  sink: DocsReceiptSink;
  transport: Transport;
  record?: DocsRecordOptions | null;
}

export interface RealDocs extends DocsPort {
  recordRefusals(): readonly FixtureRefused[];
}

export function makeRealDocs(options: RealDocsOptions): RealDocs {
  const record = options.record ?? null;
  const refusals: FixtureRefused[] = [];
  const port = docsMethods(async (verb, ref, request) => {
    const startedAt = new Date().toISOString();
    const reply = await options.transport(request);
    const receipt: DocsReceiptRecord = {
      verb,
      port: "docs",
      page: ref.page,
      heading: ref.heading,
      request,
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
        writeDocsFixture(record.dir, receipt, record.scrubber);
      } catch (error) {
        if (!(error instanceof FixtureRefused)) throw error;
        refusals.push(error);
      }
    }
    return reply;
  });
  return { ...port, recordRefusals: () => refusals };
}
