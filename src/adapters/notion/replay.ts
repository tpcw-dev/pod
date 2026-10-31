import { isDeepStrictEqual } from "node:util";
import type {
  DocsMethod,
  DocsPort,
  DocsReceiptSink,
  DocsRequest,
} from "../../core/ports/docs.ts";
import { loadFixtures, type LoadedFixture } from "./fixture.ts";
import { docsMethods } from "./methods.ts";

export class DocsReplayMismatch extends Error {}

function expected(item: LoadedFixture | undefined): string {
  if (item === undefined) return "- expected nothing";
  const { method, match } = item.entry;
  return `- expected ${item.name.slice(0, 3)} ${method} ${match.method} ${match.path} ${JSON.stringify(match.query)}`;
}

function matches(
  item: LoadedFixture,
  verb: DocsMethod,
  request: DocsRequest,
): boolean {
  const { method, match } = item.entry;
  return (
    method === verb &&
    match.method === request.method &&
    match.path === request.path &&
    isDeepStrictEqual(match.query, request.query)
  );
}

export interface ReplayDocs extends DocsPort {
  assertDone(): void;
}

export function makeReplayDocs(options: {
  dir: string;
  sink: DocsReceiptSink;
}): ReplayDocs {
  const entries = loadFixtures(options.dir);
  const consumed = new Set<LoadedFixture>();
  const open = () => entries.filter((item) => !consumed.has(item));
  const port = docsMethods(async (verb, ref, request) => {
    const item = open().find((entry) => matches(entry, verb, request));
    if (item === undefined)
      throw new DocsReplayMismatch(
        `${expected(open()[0])}\n+ actual ${verb} ${request.method} ${request.path} ${JSON.stringify(request.query)}`,
      );
    consumed.add(item);
    const { entry } = item;
    await options.sink({
      verb,
      port: "docs",
      page: ref.page,
      heading: ref.heading,
      request,
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
  });
  return {
    ...port,
    assertDone() {
      const missing = open();
      if (missing.length > 0)
        throw new DocsReplayMismatch(
          missing
            .map((item) => `${expected(item)}\n+ actual nothing`)
            .join("\n"),
        );
    },
  };
}
