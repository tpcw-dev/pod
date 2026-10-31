import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sha256 } from "../../src/adapters/linear/fixture.ts";
import {
  makeReplayTracker,
  TrackerReplayMismatch,
} from "../../src/adapters/linear/replay.ts";
import type { TrackerReceiptRecord } from "../../src/core/ports/tracker.ts";
import { issue } from "./issue.ts";

const ref = { provider: "linear", external_id: "TRK-1" };

interface Entry {
  method: string;
  operation: string;
  variables: Record<string, unknown>;
  body?: unknown;
  error?: string;
}

function dir(entries: readonly Entry[]): string {
  const at = mkdtempSync(join(tmpdir(), "pod-tracker-"));
  for (const [i, entry] of entries.entries())
    writeFileSync(
      join(at, `${String(i + 1).padStart(3, "0")}-${entry.method}.json`),
      JSON.stringify({
        method: entry.method,
        match: { operation: entry.operation, variables: entry.variables },
        status: entry.error === undefined ? 200 : null,
        body: entry.error === undefined ? JSON.stringify(entry.body) : null,
        error: entry.error ?? null,
        recordedAt: "2026-10-30T00:00:00.000Z",
      }),
    );
  return at;
}

function page(ids: string[], next: string | null) {
  return {
    data: {
      issue: {
        comments: {
          nodes: ids.map((id) => ({
            id,
            body: `body ${id}`,
            editedAt: null,
            user: { id: "u-1" },
          })),
          pageInfo: { hasNextPage: next !== null, endCursor: next },
        },
      },
    },
  };
}

function replay(entries: readonly Entry[]) {
  const records: TrackerReceiptRecord[] = [];
  const port = makeReplayTracker({
    dir: dir(entries),
    sink: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    estimateScale: "fibonacci",
  });
  return { port, records };
}

test("a two-receipt directory round-trips and logs each receipt", async () => {
  const { port, records } = replay([
    {
      method: "readStory",
      operation: "Story",
      variables: { id: "TRK-1" },
      body: { data: { issue: issue() } },
    },
    {
      method: "postComment",
      operation: "PostComment",
      variables: { issueId: "TRK-1", bodyHash: sha256("hello") },
      error: "dropped",
    },
  ]);
  expect(await port.readStory(ref)).toMatchObject({
    ok: true,
    result: { size: "m" },
  });
  expect(await port.postComment({ story: ref, body: "hello" })).toMatchObject({
    ok: false,
    error: "dropped",
  });
  port.assertDone();
  expect(records.map((record) => record.verb)).toEqual([
    "readStory",
    "postComment",
  ]);
});

test("an unmatched call, an extra call, and a missing call each fail with the diff", async () => {
  const story: Entry = {
    method: "readStory",
    operation: "Story",
    variables: { id: "TRK-1" },
    body: { data: { issue: issue() } },
  };
  const unmatched = replay([story]).port;
  await expect(
    unmatched.readStory({ provider: "linear", external_id: "TRK-2" }),
  ).rejects.toThrow(
    /- expected 001 readStory Story \{"id":"TRK-1"\}\n\+ actual readStory Story \{"id":"TRK-2"\}/,
  );
  const extra = replay([story]).port;
  await extra.readStory(ref);
  await expect(extra.readStory(ref)).rejects.toThrow(
    /- expected nothing\n\+ actual readStory Story/,
  );
  const missing = replay([story]).port;
  expect(() => missing.assertDone()).toThrow(TrackerReplayMismatch);
  expect(() => missing.assertDone()).toThrow(/\+ actual nothing/);
});

test("a Story readback follows every comment page", async () => {
  const { port } = replay([
    {
      method: "readback",
      operation: "Story",
      variables: { id: "TRK-1" },
      body: { data: { issue: issue() } },
    },
    {
      method: "readback",
      operation: "StoryComments",
      variables: { id: "TRK-1", after: null },
      body: page(["c-1"], "c-1"),
    },
    {
      method: "readback",
      operation: "StoryComments",
      variables: { id: "TRK-1", after: "c-1" },
      body: page(["c-2"], "c-2"),
    },
    {
      method: "readback",
      operation: "StoryComments",
      variables: { id: "TRK-1", after: "c-2" },
      body: page(["c-3"], null),
    },
  ]);
  const read = await port.readback(ref);
  port.assertDone();
  expect(read.ok).toBe(true);
  expect(
    read.result?.kind === "story"
      ? read.result.comments.map((comment) => comment.ref.comment_id)
      : null,
  ).toEqual(["c-1", "c-2", "c-3"]);
});

test("a comment page that fails makes the whole readback not ok", async () => {
  const { port } = replay([
    {
      method: "readback",
      operation: "Story",
      variables: { id: "TRK-1" },
      body: { data: { issue: issue() } },
    },
    {
      method: "readback",
      operation: "StoryComments",
      variables: { id: "TRK-1", after: null },
      body: page(["c-1"], "c-1"),
    },
    {
      method: "readback",
      operation: "StoryComments",
      variables: { id: "TRK-1", after: "c-1" },
      error: "timeout",
    },
  ]);
  expect(await port.readback(ref)).toMatchObject({
    ok: false,
    result: null,
    error: "timeout",
  });
  port.assertDone();
});

test("setStatus against a Canceled Story refuses with no mutation, and a failed read sends none", async () => {
  const canceled = replay([
    {
      method: "setStatus",
      operation: "Story",
      variables: { id: "TRK-1" },
      body: {
        data: {
          issue: issue({
            state: { id: "st-canceled", name: "Canceled", type: "canceled" },
          }),
        },
      },
    },
  ]);
  expect(
    await canceled.port.setStatus({ story: ref, status: "Doing" }),
  ).toMatchObject({
    ok: false,
    error: "canceled_by_human",
    result: { story: { status: "Canceled" } },
  });
  canceled.port.assertDone();
  const failed = replay([
    {
      method: "setStatus",
      operation: "Story",
      variables: { id: "TRK-1" },
      error: "timeout",
    },
  ]);
  expect(
    await failed.port.setStatus({ story: ref, status: "Doing" }),
  ).toMatchObject({ ok: false, error: "timeout", result: null });
  failed.port.assertDone();
});

test("setStatus moves an open Story to the named state", async () => {
  const { port } = replay([
    {
      method: "setStatus",
      operation: "Story",
      variables: { id: "TRK-1" },
      body: { data: { issue: issue() } },
    },
    {
      method: "setStatus",
      operation: "SetStatus",
      variables: { id: "TRK-1", stateId: "st-doing" },
      body: {
        data: {
          issueUpdate: {
            success: true,
            issue: issue({
              state: { id: "st-doing", name: "Doing", type: "started" },
            }),
          },
        },
      },
    },
  ]);
  expect(await port.setStatus({ story: ref, status: "Doing" })).toMatchObject({
    ok: true,
    result: { story: { status: "Doing" } },
  });
  port.assertDone();
});
