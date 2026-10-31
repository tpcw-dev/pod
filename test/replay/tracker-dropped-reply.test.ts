import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { bodyHash, commentPayload } from "../../src/core/tracker/outbox.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import {
  applyConfig,
  check,
  enqueue,
  scenario,
  secondCheckOrca,
  startRun,
  trackerReceipts,
} from "./tracker-scenario.ts";

const dir = "fixtures/tracker/tracker-dropped-reply";
const body = "pod fixture: tracker-dropped-reply";

describeDb("tracker-dropped-reply", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig();
  });
  afterAll(() => conn.close());

  test("a dropped comment reply is acked by its readback, and a second check posts nothing", async () => {
    const run = await scenario(conn, dir);
    const { orca, runId } = await startRun(conn, run);
    const id = await enqueue(conn, commentPayload(run.story, body));

    const first = await check(conn, orca, run, runId);
    orca.assertDone();
    expect(first.ok).toBe(true);
    const again = secondCheckOrca(run.log);
    const second = await check(conn, again, run, runId);
    again.assertDone();
    run.tracker.assertDone?.();
    expect(second.ok).toBe(true);

    expect(await trackerReceipts(conn)).toEqual([
      { verb: "readStory", operation: "Story" },
      { verb: "readback", operation: "Story" },
      { verb: "readback", operation: "StoryComments" },
      { verb: "postComment", operation: "PostComment" },
      { verb: "readback", operation: "Story" },
      { verb: "readback", operation: "StoryComments" },
      { verb: "readStory", operation: "Story" },
    ]);
    const [row] = await conn.sql<
      {
        tries: number;
        last_error: string | null;
        readback: { comments: { body: string }[] };
      }[]
    >`select tries, last_error, readback from ledger.outbox where id = ${id} and acked_at is not null`;
    expect(row).toMatchObject({ tries: 0, last_error: null });
    expect(
      row?.readback.comments.filter(
        (comment) => bodyHash(comment.body) === bodyHash(body),
      ),
    ).toHaveLength(1);
  });
});
