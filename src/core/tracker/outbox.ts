import { createHash } from "node:crypto";
import { Json } from "../domain/json.ts";
import { OutboxPayload, type OutboxRow } from "../domain/ledger.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import {
  canceledByHuman,
  type StoryRef,
  type TrackerPort,
} from "../ports/tracker.ts";
import { cancelRun } from "./sync.ts";

export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function commentPayload(story: StoryRef, body: string): OutboxPayload {
  return { kind: "comment", story, body, hash: bodyHash(body) };
}

export interface DrainInput {
  host: string;
  now: () => Date;
}

export interface Drained {
  acked: number[];
  failed: { id: number; error: string }[];
}

type CommentPayload = Extract<OutboxPayload, { kind: "comment" }>;
type StatusPayload = Extract<OutboxPayload, { kind: "status" }>;

function payloadOf(row: OutboxRow): OutboxPayload | null {
  const parsed = OutboxPayload.safeParse(row.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  if (payload.kind === "comment" && payload.hash !== bodyHash(payload.body))
    return null;
  return payload;
}

async function hashPresent(tracker: TrackerPort, payload: CommentPayload) {
  const read = await tracker.readback(payload.story);
  if (!read.ok || read.result?.kind !== "story") return { ok: false as const };
  const found = read.result.comments.some(
    (comment) => bodyHash(comment.body) === payload.hash,
  );
  return { ok: true as const, found, readback: Json.parse(read.result) };
}

async function drainComment(
  tracker: TrackerPort,
  payload: CommentPayload,
): Promise<{ ack: Json } | { fail: string }> {
  const first = await hashPresent(tracker, payload);
  if (!first.ok) return { fail: "readback_failed" };
  if (first.found) return { ack: first.readback };
  const post = await tracker.postComment({
    story: payload.story,
    body: payload.body,
  });
  const second = await hashPresent(tracker, payload);
  if (!second.ok) return { fail: "readback_failed" };
  if (second.found) return { ack: second.readback };
  return { fail: post.ok ? "readback_missing" : (post.error ?? "failed") };
}

async function drainStatus(
  db: Db,
  tracker: TrackerPort,
  payload: StatusPayload,
  runId: string | null,
  input: DrainInput,
): Promise<{ ack: Json } | { fail: string }> {
  const set = await tracker.setStatus({
    story: payload.story,
    status: payload.status,
  });
  const story = set.result?.story ?? null;
  if (set.error === canceledByHuman && story !== null) {
    if (runId !== null)
      await db.transaction((tx) =>
        cancelRun(tx, runId, story.status, input.host, input.now()),
      );
    return {
      ack: Json.parse({ kind: "story", story, error: canceledByHuman }),
    };
  }
  if (set.ok && story !== null)
    return { ack: Json.parse({ kind: "story", story }) };
  return { fail: set.error ?? "failed" };
}

export async function drainOutbox(
  db: Db,
  tracker: TrackerPort,
  log: ReceiptLog,
  input: DrainInput,
): Promise<Drained> {
  const drained: Drained = { acked: [], failed: [] };
  for (const row of await db.listOutboxPending()) {
    const payload = payloadOf(row);
    let outcome: { ack: Json } | { fail: string };
    if (payload === null) outcome = { fail: "payload_invalid" };
    else {
      const runId =
        (await db.getStory(payload.story.provider, payload.story.external_id))
          ?.run_id ?? null;
      log.at({
        run_id: runId,
        task_id: null,
        op_key: row.op_key,
      });
      outcome =
        payload.kind === "comment"
          ? await drainComment(tracker, payload)
          : await drainStatus(db, tracker, payload, runId, input);
    }
    if ("ack" in outcome) {
      await db.ackOutbox(row.id, outcome.ack);
      drained.acked.push(row.id);
    } else {
      await db.failOutbox(row.id, outcome.fail);
      drained.failed.push({ id: row.id, error: outcome.fail });
    }
  }
  return drained;
}
