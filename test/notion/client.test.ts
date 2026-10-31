import { expect, test } from "vitest";
import {
  fetchTransport,
  notionUrl,
  notionVersion,
} from "../../src/adapters/notion/client.ts";
import { makeRealDocs } from "../../src/adapters/notion/real.ts";
import type { DocsReceiptRecord } from "../../src/core/ports/docs.ts";

const page = "p-1";

function text(content: string) {
  return [{ type: "text", plain_text: content }];
}

function block(id: string, type: string, payload: unknown, children = false) {
  return { object: "block", id, type, has_children: children, [type]: payload };
}

const heading = (id: string, words: string, type = "heading_2") =>
  block(id, type, { rich_text: text(words), is_toggleable: false });
const paragraph = (id: string, words: string) =>
  block(id, "paragraph", { rich_text: text(words) });

function listing(results: unknown[], next: string | null = null) {
  return {
    object: "list",
    type: "block",
    block: {},
    results,
    has_more: next !== null,
    next_cursor: next,
  };
}

function row(id: string, cells: string[]) {
  return block(id, "table_row", { cells: cells.map(text) });
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "x-notion-request-id": "req-1" },
  });
}

interface Call {
  url: URL;
  init: RequestInit;
}

function docs(
  answer: (url: URL) => Response | Promise<Response>,
  calls: Call[] = [],
  records: DocsReceiptRecord[] = [],
) {
  return makeRealDocs({
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    transport: fetchTransport(
      "secret-token",
      (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(answer(url));
      },
      50,
    ),
  });
}

test("a section read sends the version and bearer headers and records no token", async () => {
  const calls: Call[] = [];
  const records: DocsReceiptRecord[] = [];
  const port = docs(
    () =>
      reply(
        listing([
          paragraph("b-0", "before any heading"),
          heading("b-1", "  Current milestone "),
          paragraph("b-2", "Milestone one"),
          block("b-3", "bulleted_list_item", { rich_text: text("a bullet") }),
          block("b-4", "numbered_list_item", { rich_text: text("a step") }),
          block("b-5", "image", { type: "external" }),
          heading("b-6", "Next", "heading_3"),
          paragraph("b-7", "after the section"),
        ]),
      ),
    calls,
    records,
  );
  const read = await port.readSection({ page, heading: "Current milestone" });
  expect(calls).toHaveLength(1);
  expect(`${calls[0]?.url.origin}${calls[0]?.url.pathname}`).toBe(
    `${notionUrl}/blocks/${page}/children`,
  );
  expect(calls[0]?.url.searchParams.get("page_size")).toBe("100");
  expect(calls[0]?.init.method).toBe("GET");
  expect(calls[0]?.init.headers).toMatchObject({
    Authorization: "Bearer secret-token",
    "Notion-Version": notionVersion,
  });
  expect(notionVersion).toBe("2022-06-28");
  expect(read).toMatchObject({
    verb: "readSection",
    ok: true,
    error: null,
    requestId: "req-1",
    result: {
      heading: "Current milestone",
      paragraphs: ["Milestone one", "a bullet", "a step"],
      tables: [],
    },
  });
  expect(records).toMatchObject([
    {
      verb: "readSection",
      port: "docs",
      page,
      heading: "Current milestone",
      request: {
        method: "GET",
        path: `/v1/blocks/${page}/children`,
        query: { page_size: "100" },
      },
      status: 200,
      requestId: "req-1",
    },
  ]);
  expect(JSON.stringify(records)).not.toContain("secret-token");
});

test("a two-page listing follows start_cursor until has_more is false", async () => {
  const calls: Call[] = [];
  const port = docs((url) => {
    const cursor = url.searchParams.get("start_cursor");
    if (cursor === null)
      return reply(
        listing([heading("b-1", "Notes"), paragraph("b-2", "one")], "b-3"),
      );
    return reply(listing([paragraph("b-3", "two")]));
  }, calls);
  const read = await port.readSection({ page, heading: "Notes" });
  expect(
    calls.map((call) => call.url.searchParams.get("start_cursor")),
  ).toEqual([null, "b-3"]);
  expect(read.result?.paragraphs).toEqual(["one", "two"]);
});

test("paging stops once the section has ended", async () => {
  const calls: Call[] = [];
  const port = docs(
    () =>
      reply(
        listing(
          [
            heading("b-1", "Notes"),
            paragraph("b-2", "one"),
            heading("b-3", "Other", "heading_1"),
          ],
          "b-4",
        ),
      ),
    calls,
  );
  const read = await port.readSection({ page, heading: "Notes" });
  expect(calls).toHaveLength(1);
  expect(read.result?.paragraphs).toEqual(["one"]);
});

test("a table reads its rows, the first as header when has_column_header is true", async () => {
  const calls: Call[] = [];
  const port = docs((url) => {
    if (url.pathname.endsWith("/t-1/children"))
      return reply(
        listing([
          row("r-1", ["Milestone", "Status"]),
          row("r-2", ["One", "Done"]),
        ]),
      );
    if (url.pathname.endsWith("/t-2/children"))
      return reply(listing([row("r-3", ["a", "b"])]));
    return reply(
      listing([
        heading("b-1", "Milestones"),
        block(
          "t-1",
          "table",
          { table_width: 2, has_column_header: true, has_row_header: false },
          true,
        ),
        block("t-2", "table", { table_width: 2, has_row_header: false }, true),
      ]),
    );
  }, calls);
  const read = await port.readSection({ page, heading: "Milestones" });
  expect(read.ok).toBe(true);
  expect(read.result?.tables).toEqual([
    { header: ["Milestone", "Status"], rows: [["One", "Done"]] },
    { header: [], rows: [["a", "b"]] },
  ]);
  expect(calls.map((call) => call.url.pathname)).toEqual([
    `/v1/blocks/${page}/children`,
    "/v1/blocks/t-1/children",
    "/v1/blocks/t-2/children",
  ]);
});

test("a text block without rich_text adds nothing, and a heading without it is not a heading", async () => {
  const port = docs(() =>
    reply(
      listing([
        heading("b-1", "Notes"),
        block("b-2", "paragraph", { color: "default" }),
        block("b-3", "heading_2", { color: "default" }),
        paragraph("b-4", "still inside"),
      ]),
    ),
  );
  const read = await port.readSection({ page, heading: "Notes" });
  expect(read.result?.paragraphs).toEqual(["still inside"]);
});

test("a table_row without cells is unparsed", async () => {
  const port = docs((url) => {
    if (url.pathname.endsWith("/t-1/children"))
      return reply(listing([block("r-1", "table_row", { color: "default" })]));
    return reply(
      listing([
        heading("b-1", "Milestones"),
        block("t-1", "table", { has_column_header: true }, true),
      ]),
    );
  });
  expect(await port.readSection({ page, heading: "Milestones" })).toMatchObject(
    {
      ok: false,
      result: null,
      error: "unparsed",
    },
  );
});

test("a page with no matching heading_2 is docs_section_not_found", async () => {
  const port = docs(() =>
    reply(
      listing([heading("b-1", "Nope", "heading_1"), heading("b-2", "Other")]),
    ),
  );
  expect(await port.readSection({ page, heading: "Nope" })).toMatchObject({
    verb: "readSection",
    ok: false,
    result: null,
    error: "docs_section_not_found",
  });
});

test("a Notion error body returns its code, and a bare status returns http_<status>", async () => {
  const coded = docs(() =>
    reply(
      { object: "error", status: 404, code: "object_not_found", message: "x" },
      404,
    ),
  );
  expect(await coded.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "object_not_found",
  });
  const bare = docs(() => new Response("oops", { status: 502 }));
  expect(await bare.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "http_502",
  });
});

test("a body that is not a listing is unparsed", async () => {
  const port = docs(() => reply({ results: "nope" }));
  expect(await port.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "unparsed",
  });
});

test("has_more with no next_cursor is pages_incomplete", async () => {
  const port = docs(() =>
    reply({
      ...listing([heading("b-1", "Notes")]),
      has_more: true,
      next_cursor: null,
    }),
  );
  expect(await port.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "pages_incomplete",
  });
});

test("a slow reply is a timeout and a thrown fetch is network", async () => {
  const slow = makeRealDocs({
    sink: () => Promise.resolve(),
    transport: fetchTransport(
      "secret-token",
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
      20,
    ),
  });
  expect(await slow.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "timeout",
  });
  const down = makeRealDocs({
    sink: () => Promise.resolve(),
    transport: fetchTransport("secret-token", () =>
      Promise.reject(new TypeError("fetch failed")),
    ),
  });
  expect(await down.readSection({ page, heading: "Notes" })).toMatchObject({
    ok: false,
    error: "network",
  });
});
