import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DocsFixtureInvalid } from "../../src/adapters/notion/fixture.ts";
import {
  DocsReplayMismatch,
  makeReplayDocs,
} from "../../src/adapters/notion/replay.ts";
import type { DocsReceiptRecord } from "../../src/core/ports/docs.ts";

const page = "p-1";

interface Entry {
  path: string;
  query?: Record<string, string>;
  body: unknown;
}

function text(content: string) {
  return [{ plain_text: content }];
}

function listing(results: unknown[], next: string | null = null) {
  return { results, has_more: next !== null, next_cursor: next };
}

const heading = (id: string, words: string) => ({
  id,
  type: "heading_2",
  heading_2: { rich_text: text(words) },
});
const paragraph = (id: string, words: string) => ({
  id,
  type: "paragraph",
  paragraph: { rich_text: text(words) },
});

function dir(entries: readonly Entry[]): string {
  const at = mkdtempSync(join(tmpdir(), "pod-docs-"));
  for (const [i, entry] of entries.entries())
    writeFileSync(
      join(at, `${String(i + 1).padStart(3, "0")}-readSection.json`),
      JSON.stringify({
        method: "readSection",
        page,
        heading: "Notes",
        match: {
          method: "GET",
          path: entry.path,
          query: entry.query ?? { page_size: "100" },
        },
        status: 200,
        body: JSON.stringify(entry.body),
        error: null,
        recordedAt: "2026-10-31T00:00:00.000Z",
      }),
    );
  return at;
}

function replay(at: string) {
  const records: DocsReceiptRecord[] = [];
  const port = makeReplayDocs({
    dir: at,
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
  return { port, records };
}

const pagePath = `/v1/blocks/${page}/children`;

test("matched requests replay the recorded bodies and reach the sink", async () => {
  const { port, records } = replay(
    dir([
      {
        path: pagePath,
        body: listing(
          [heading("b-1", "Notes"), paragraph("b-2", "one")],
          "b-3",
        ),
      },
      {
        path: pagePath,
        query: { page_size: "100", start_cursor: "b-3" },
        body: listing([paragraph("b-3", "two")]),
      },
    ]),
  );
  expect(await port.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: true,
    result: { heading: "Notes", paragraphs: ["one", "two"], tables: [] },
  });
  port.assertDone();
  expect(records.map((record) => record.request.query)).toEqual([
    { page_size: "100" },
    { page_size: "100", start_cursor: "b-3" },
  ]);
  expect(records[0]).toMatchObject({
    verb: "readSection",
    port: "docs",
    page,
    heading: "Notes",
    status: 200,
    startedAt: "2026-10-31T00:00:00.000Z",
  });
});

test("a second-page request does not match a first-page entry", async () => {
  const { port } = replay(
    dir([
      {
        path: pagePath,
        body: listing([heading("b-1", "Notes")], "b-3"),
      },
      { path: pagePath, body: listing([paragraph("b-9", "stale")]) },
    ]),
  );
  await expect(port.readSection({ page, heading: "Notes" })).rejects.toThrow(
    DocsReplayMismatch,
  );
});

test("an unmatched request names the next unconsumed entry and the actual request", async () => {
  const { port } = replay(
    dir([{ path: "/v1/blocks/other/children", body: listing([]) }]),
  );
  await expect(port.readSection({ page, heading: "Notes" })).rejects.toThrow(
    /- expected 001 readSection GET \/v1\/blocks\/other\/children[\s\S]*\+ actual readSection GET \/v1\/blocks\/p-1\/children/,
  );
});

test("a later request skips an identical earlier-recorded request and takes its own entry", async () => {
  const withTable = listing([
    heading("b-1", "Notes"),
    paragraph("b-2", "first"),
    { id: "t-1", type: "table", table: { has_column_header: false } },
  ]);
  const { port } = replay(
    dir([
      { path: pagePath, body: withTable },
      { path: pagePath, body: withTable },
      {
        path: "/v1/blocks/t-1/children",
        body: listing([
          { id: "r-1", type: "table_row", table_row: { cells: [text("a")] } },
        ]),
      },
    ]),
  );
  const read = await port.readSection({ page, heading: "Notes" });
  expect(read.result).toEqual({
    heading: "Notes",
    paragraphs: ["first"],
    tables: [{ header: [], rows: [["a"]] }],
  });
  expect(() => port.assertDone()).toThrow(
    /^- expected 002 [^\n]*\n\+ actual nothing$/,
  );
});

test("assertDone lists every unconsumed entry", async () => {
  const { port } = replay(
    dir([
      { path: pagePath, body: listing([heading("b-1", "Notes")]) },
      { path: "/v1/blocks/x/children", body: listing([]) },
      { path: "/v1/blocks/y/children", body: listing([]) },
    ]),
  );
  await port.readSection({ page, heading: "Notes" });
  expect(() => port.assertDone()).toThrow(
    /- expected 002 [^\n]*\/x\/children [^\n]*\n\+ actual nothing\n- expected 003 [^\n]*\/y\/children [^\n]*\n\+ actual nothing/,
  );
});

test("a fixture that is not JSON or fails the schema names the file", () => {
  const broken = mkdtempSync(join(tmpdir(), "pod-docs-"));
  writeFileSync(join(broken, "001-readSection.json"), "{nope");
  expect(() => replay(broken)).toThrow(DocsFixtureInvalid);
  expect(() => replay(broken)).toThrow(/001-readSection\.json/);
  const wrong = mkdtempSync(join(tmpdir(), "pod-docs-"));
  writeFileSync(
    join(wrong, "001-readSection.json"),
    JSON.stringify({ method: "readSection" }),
  );
  expect(() => replay(wrong)).toThrow(/001-readSection\.json/);
});
