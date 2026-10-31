import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fetchTransport, linearUrl } from "../../src/adapters/linear/client.ts";
import { makeRealTracker } from "../../src/adapters/linear/real.ts";
import type { TrackerReceiptRecord } from "../../src/core/ports/tracker.ts";
import { issue } from "./issue.ts";

const ref = { provider: "linear", external_id: "TRK-1" };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "x-request-id": "req-1" },
  });
}

function tracker(fetchFn: typeof fetch, records: TrackerReceiptRecord[] = []) {
  return makeRealTracker({
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    transport: fetchTransport("secret-token", fetchFn, 50),
    estimateScale: "fibonacci",
  });
}

test("a Story read posts to the Linear endpoint with the token header and records no token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const records: TrackerReceiptRecord[] = [];
  const port = tracker((url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(reply({ data: { issue: issue() } }));
  }, records);
  const read = await port.readStory(ref);
  expect(calls[0]?.url).toBe(linearUrl);
  expect(calls[0]?.init.headers).toMatchObject({
    Authorization: "secret-token",
  });
  expect(read).toMatchObject({
    verb: "readStory",
    ok: true,
    requestId: "req-1",
    result: {
      ref,
      stageLabel: "impl",
      size: "m",
      kickoffLine: { name: "impl-small", rev: 1 },
      kickoffText: "Kickoff: impl-small@1",
      status: "Backlog",
      statusType: "backlog",
    },
  });
  expect(JSON.stringify(records)).not.toContain("secret-token");
  expect(records.map((record) => record.operation)).toEqual(["Story"]);
});

test("Entity not found is a found-nothing receipt", async () => {
  const port = tracker(() =>
    Promise.resolve(
      reply({ data: null, errors: [{ message: "Entity not found: Issue" }] }),
    ),
  );
  expect(await port.readStory(ref)).toMatchObject({
    ok: true,
    result: null,
  });
});

test("a GraphQL error, a non-2xx status, a timeout, and an unparsed body are not ok", async () => {
  const graphql = tracker(() =>
    Promise.resolve(reply({ errors: [{ message: "rate limited" }] })),
  );
  expect(await graphql.readStory(ref)).toMatchObject({
    ok: false,
    error: "rate limited",
  });
  const http = tracker(() => Promise.resolve(reply({}, 502)));
  expect(await http.readStory(ref)).toMatchObject({
    ok: false,
    error: "http_502",
  });
  const slow = tracker(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason as Error),
        );
      }),
  );
  expect(await slow.readStory(ref)).toMatchObject({
    ok: false,
    error: "timeout",
  });
  const odd = tracker(() =>
    Promise.resolve(reply({ data: { issue: { identifier: "TRK-1" } } })),
  );
  expect(await odd.readStory(ref)).toMatchObject({
    ok: false,
    error: "unparsed",
  });
});

test("a dropped reply is recorded after the request completed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-tracker-record-"));
  let sent = 0;
  const records: TrackerReceiptRecord[] = [];
  const port = makeRealTracker({
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    transport: fetchTransport("t", () => {
      sent += 1;
      return Promise.resolve(
        reply({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "c-1", body: "hi", editedAt: null, user: null },
            },
          },
        }),
      );
    }),
    estimateScale: "fibonacci",
    record: {
      dir,
      kill: "postComment",
      scrubber: { scrub: (text) => text, hits: () => [] },
    },
  });
  expect(await port.postComment({ story: ref, body: "hi" })).toMatchObject({
    ok: false,
    result: null,
    error: "dropped",
  });
  expect(sent).toBe(1);
  expect(records[0]).toMatchObject({ status: null, error: "dropped" });
  expect(readdirSync(dir)).toEqual(["001-postComment.json"]);
  expect(
    JSON.parse(readFileSync(join(dir, "001-postComment.json"), "utf8")),
  ).toMatchObject({
    method: "postComment",
    match: {
      operation: "PostComment",
      variables: {
        issueId: "TRK-1",
        bodyHash:
          "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
      },
    },
    status: null,
    body: null,
    error: "dropped",
  });
});
