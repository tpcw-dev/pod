import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { OutboxPayload } from "../../src/core/domain/ledger.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { commentPayload, drainOutbox } from "../../src/core/tracker/outbox.ts";
import { fakeTracker, trackerStory, type FakeTracker } from "./fake-tracker.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { freshRun } from "./run-fixture.ts";

const story = { provider: "linear", external_id: "S-1" };

describeDb("tracker outbox drain", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    expect(runCli(["db", "migrate"]).status).toBe(0);
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => freshRun(conn));

  async function enqueue(payload: OutboxPayload) {
    const key = `verdict-${Math.random().toString(36).slice(2)}`;
    await conn.db.insertOperation({
      op_key: key,
      intent: "verdict",
      owner_generation: 1,
      at: new Date(),
    });
    const row = await conn.db.enqueueOutbox({
      op_key: key,
      target: "tracker",
      payload,
    });
    return row.id;
  }

  const enqueueComment = (body: string) => enqueue(commentPayload(story, body));

  function drain(fake: FakeTracker) {
    return drainOutbox(conn.db, fake, receiptLog(conn.db, "local"), {
      host: "local",
      now: () => new Date(),
    });
  }

  async function row(id: number) {
    const [found] = await conn.sql<
      { tries: number; last_error: string | null; acked: boolean }[]
    >`select tries, last_error, acked_at is not null as acked from ledger.outbox where id = ${id}`;
    return found;
  }

  test("a dropped reply then a readback acks once, and a second drain posts nothing", async () => {
    const id = await enqueueComment("verdict PASS");
    const fake = fakeTracker();
    fake.dropPost = true;
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["readback", "postComment", "readback"]);
    expect(await row(id)).toEqual({ tries: 0, last_error: null, acked: true });
    fake.calls.length = 0;
    expect(await drain(fake)).toEqual({ acked: [], failed: [] });
    expect(fake.calls).toEqual([]);
    expect(fake.comments).toHaveLength(1);
  });

  test("a post that succeeds but does not show records readback_missing, and the next drain acks without a second post", async () => {
    const id = await enqueueComment("verdict FAIL");
    const fake = fakeTracker();
    fake.postLands = false;
    expect(await drain(fake)).toEqual({
      acked: [],
      failed: [{ id, error: "readback_missing" }],
    });
    expect(await row(id)).toEqual({
      tries: 1,
      last_error: "readback_missing",
      acked: false,
    });
    fake.comments.push({
      ref: { ...story, comment_id: "late" },
      authorId: "bot",
      body: "verdict FAIL",
      editedAt: null,
    });
    fake.calls.length = 0;
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["readback"]);
  });

  test("a comment already present is acked with no post", async () => {
    const id = await enqueueComment("already here");
    const fake = fakeTracker();
    fake.comments.push({
      ref: { ...story, comment_id: "c-0" },
      authorId: "human",
      body: "already here",
      editedAt: null,
    });
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["readback"]);
  });

  test("a failed first readback fails the row with no post", async () => {
    const id = await enqueueComment("not yet");
    const fake = fakeTracker();
    fake.failReadbacks = [1];
    expect(await drain(fake)).toEqual({
      acked: [],
      failed: [{ id, error: "readback_failed" }],
    });
    expect(fake.calls).toEqual(["readback"]);
  });

  test("a failed second readback fails the row after one post", async () => {
    const id = await enqueueComment("posted blind");
    const fake = fakeTracker();
    fake.failReadbacks = [2];
    expect(await drain(fake)).toEqual({
      acked: [],
      failed: [{ id, error: "readback_failed" }],
    });
    expect(fake.calls).toEqual(["readback", "postComment", "readback"]);
    fake.calls.length = 0;
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["readback"]);
  });

  test("a hash that is not sha256 of the body is payload_invalid with no port call", async () => {
    const id = await enqueue({
      kind: "comment",
      story,
      body: "x",
      hash: "0".repeat(64),
    });
    const fake = fakeTracker();
    expect(await drain(fake)).toEqual({
      acked: [],
      failed: [{ id, error: "payload_invalid" }],
    });
    expect(fake.calls).toEqual([]);
  });

  test("a status row against a Canceled Story is acked canceled_by_human with no mutation, and cancels the Run once", async () => {
    const id = await enqueue({ kind: "status", story, status: "Doing" });
    const fake = fakeTracker(
      trackerStory({ status: "Canceled", statusType: "canceled" }),
    );
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["setStatus"]);
    const [acked] = await conn.sql<
      { readback: { error: string } }[]
    >`select readback from ledger.outbox where id = ${id}`;
    expect(acked?.readback.error).toBe("canceled_by_human");
    expect(
      await conn.sql`select payload from ledger.event where type = 'cancel'`,
    ).toEqual([
      { payload: { reason: "tracker_canceled", status: "Canceled" } },
    ]);
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    await enqueue({ kind: "status", story, status: "Doing" });
    await drain(fake);
    expect(
      await conn.sql`select 1 from ledger.event where type = 'cancel'`,
    ).toHaveLength(1);
  });

  test("a status row whose Story read fails is failed with the read error and no mutation", async () => {
    const id = await enqueue({ kind: "status", story, status: "Doing" });
    const fake = fakeTracker();
    fake.failRead = true;
    expect(await drain(fake)).toEqual({
      acked: [],
      failed: [{ id, error: "timeout" }],
    });
    expect(fake.calls).toEqual(["setStatus"]);
  });

  test("a status row against an open Story sets the status and acks", async () => {
    const id = await enqueue({ kind: "status", story, status: "Doing" });
    const fake = fakeTracker();
    expect(await drain(fake)).toEqual({ acked: [id], failed: [] });
    expect(fake.calls).toEqual(["setStatus", "setStatus:mutation"]);
    expect(fake.story.status).toBe("Doing");
  });
});
