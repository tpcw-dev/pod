import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, type CheckInput } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { reply, type ReplyInput } from "../../src/core/check/reply.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  batch,
  dispatched,
  empty,
  events,
  freshRun,
  replay,
  workers,
} from "./run-fixture.ts";

const run = ["--run", "run_1"];
const coordinator = "session-1";
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function ask(
  id: string,
  over: {
    subject?: string;
    body?: string;
    payload?: object;
    type?: string;
  } = {},
): unknown {
  return {
    id,
    type: over.type ?? "escalation",
    subject: over.subject ?? `subject of ${id}`,
    body: over.body ?? `body of ${id}`,
    payload: JSON.stringify(
      over.payload ?? { dispatchId: "ctx_1", taskId: "task_b" },
    ),
  };
}

const stopNotice = (id: string, dispatchId = "ctx_1") =>
  ask(id, {
    subject: "Worker stopped without reporting",
    payload: {
      taskId: "task_b",
      dispatchId,
      handle: "term_x",
      stopReason: "finished",
    },
  });

const sentOk = (id: string) => ({ message: { id } });

function refusedReply(verb: string, code: string, argv: string[]): TempEntry {
  return {
    verb,
    argv,
    exitCode: 0,
    stdout: JSON.stringify({
      ok: false,
      error: { code, message: "a question takes one answer only" },
    }),
  };
}

describeDb("pod reply", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await dispatched(conn, "ctx_1");
  });
  afterAll(() => conn.close());

  function checkInput(): CheckInput {
    return {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 1,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    };
  }

  async function check(messages: unknown[] = []) {
    const entries: TempEntry[] =
      messages.length === 0
        ? [ok("check", empty(), run)]
        : [
            ok("check", batch("delivery_1", messages), run),
            ok("check", empty("delivery_1"), ["--ack", "delivery_1"]),
          ];
    const { orca, log } = replay(conn, [
      ...entries,
      ok("worker-list", workers([]), run),
    ]);
    const outcome = await checkPass(conn.db, orca, null, log, checkInput());
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result;
  }

  function input(
    message: string,
    body: string,
    over: Partial<ReplyInput> = {},
  ) {
    return {
      message,
      body,
      generation: 1,
      host: "local",
      now: () => new Date(),
      ...over,
    };
  }

  async function answer(
    entries: readonly TempEntry[],
    message: string,
    body: string,
    over: Partial<ReplyInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await reply(conn.db, orca, log, input(message, body, over));
    orca.assertDone();
    return outcome;
  }

  const quiet = (
    message: string,
    body: string,
    over: Partial<ReplyInput> = {},
  ) =>
    reply(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      input(message, body, over),
    );

  async function sentArgv() {
    const rows = await events(conn, "receipt");
    return rows
      .map((row) => row.payload["argv"] as string[])
      .filter((argv) => argv[1] === "reply" || argv[1] === "send");
  }

  const replyOk = (id: string) =>
    ok("reply", sentOk(`msg_sent_${id}`), ["--id", id]);
  const sendOk = (id: string, argv: string[] = []) =>
    ok("send", sentOk(`msg_sent_${id}`), ["--to", "dispatch:ctx_1", ...argv]);

  test("pod check names the question, pod reply answers it once, and the next check names it no more", async () => {
    const first = await check([
      ask("msg_q", {
        subject: "where is my ticket",
        body: "I cannot find the ticket.",
      }),
    ]);
    expect(first.nextSteps).toContain(
      "worker asks on ctx_1 (where is my ticket): pod reply --message msg_q --generation 1 FILE",
    );
    expect(first.questions).toEqual([
      {
        message_id: "msg_q",
        dispatch_id: "ctx_1",
        task_id: "task_b",
        type: "escalation",
        subject: "where is my ticket",
        body: "I cannot find the ticket.",
        body_truncated: false,
        notice: false,
        folded: [],
        unfinished: null,
      },
    ]);

    const outcome = await answer([replyOk("msg_q")], "msg_q", "It is TPC-1.");
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        message_id: "msg_q",
        dispatch_id: "ctx_1",
        transport: "reply",
        content_hash: sha("It is TPC-1."),
        sent_message_id: "msg_sent_msg_q",
        replayed: false,
        answered_elsewhere: false,
      },
    });
    expect(await sentArgv()).toEqual([
      [
        "orchestration",
        "reply",
        "--id",
        "msg_q",
        "--body",
        "It is TPC-1.",
        "--from",
        coordinator,
        "--json",
        "--full",
      ],
    ]);
    expect((await events(conn, "reply")).map((row) => row.payload)).toEqual([
      {
        question_id: "msg_q",
        transport: "reply",
        content_hash: sha("It is TPC-1."),
        body: "It is TPC-1.",
        body_truncated: false,
        sent_message_id: "msg_sent_msg_q",
        answered_elsewhere: false,
      },
    ]);
    if (!outcome.ok) throw new Error("unreachable");
    expect((await conn.db.getOperation(outcome.opKey))?.status).toBe("done");
    expect((await conn.db.getDispatch("ctx_1"))?.activity).toBe("running");

    const next = await check();
    expect(next.nextSteps.filter((line) => line.includes("msg_q"))).toEqual([]);
    expect(next.questions).toEqual([]);

    const again = await quiet("msg_q", "It is TPC-1.");
    expect(again).toMatchObject({
      ok: true,
      result: { replayed: true, transport: "reply" },
    });
    expect(await events(conn, "reply")).toHaveLength(1);
  });

  test("a follow-up to an answered question goes on the thread as its own event", async () => {
    await check([ask("msg_q", { subject: "help" })]);
    await answer([replyOk("msg_q")], "msg_q", "T");
    const outcome = await answer(
      [sendOk("msg_q", ["--thread-id", "msg_q"])],
      "msg_q",
      "U",
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { transport: "thread" },
    });
    expect((await sentArgv()).at(-1)).toEqual([
      "orchestration",
      "send",
      "--to",
      "dispatch:ctx_1",
      "--subject",
      "Re: help",
      "--body",
      "U",
      "--thread-id",
      "msg_q",
      "--from",
      coordinator,
      "--json",
      "--full",
    ]);
    expect(
      (await events(conn, "reply")).map((row) => [
        row.payload["transport"],
        row.payload["content_hash"],
      ]),
    ).toEqual([
      ["reply", sha("T")],
      ["thread", sha("U")],
    ]);
  });

  test("a stop notice folds into the question's line, and a notice alone is answered by a send", async () => {
    const both = await check([stopNotice("msg_stop_x"), ask("msg_q2")]);
    expect(both.nextSteps).toContain(
      "worker asks on ctx_1 (subject of msg_q2): pod reply --message msg_q2 --generation 1 FILE; folds msg_stop_x",
    );
    await answer([replyOk("msg_q2")], "msg_q2", "T");
    const alone = await check();
    expect(alone.nextSteps).toContain(
      "worker asks on ctx_1 (Worker stopped without reporting): pod reply --message msg_stop_x --generation 1 FILE",
    );
    const outcome = await answer(
      [sendOk("msg_stop_x")],
      "msg_stop_x",
      "carry on",
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { transport: "thread" },
    });
    const argv = (await sentArgv()).at(-1);
    expect(argv?.slice(0, 4)).toEqual([
      "orchestration",
      "send",
      "--to",
      "dispatch:ctx_1",
    ]);
    expect(argv).not.toContain("--thread-id");
    expect((await check()).questions).toEqual([]);
  });

  test("two questions on one Dispatch close one at a time, oldest named first", async () => {
    expect((await check([ask("msg_a"), ask("msg_b")])).nextSteps).toContain(
      "worker asks on ctx_1 (subject of msg_a): pod reply --message msg_a --generation 1 FILE; folds msg_b",
    );
    await answer([replyOk("msg_b")], "msg_b", "B");
    expect((await check()).nextSteps).toContain(
      "worker asks on ctx_1 (subject of msg_a): pod reply --message msg_a --generation 1 FILE",
    );
    await answer([replyOk("msg_a")], "msg_a", "A");
    expect(
      (await check()).nextSteps.filter((line) => line.includes("ctx_1")),
    ).toEqual([]);
  });

  test("the waiting delivery records the body and whether the runtime wrote it as a notice", async () => {
    await check([
      stopNotice("msg_stop_y"),
      ask("msg_follow", {
        subject: "Mail did not reach the finished worker",
        payload: { dispatchId: "ctx_1", reason: "timeout" },
      }),
      ask("msg_plain"),
      ask("msg_odd", {
        payload: { dispatchId: "ctx_1", taskId: "task_b", stopReason: 1 },
      }),
    ]);
    const rows = (await events(conn, "delivery")).map((row) => row.payload);
    expect(rows).toEqual([
      expect.objectContaining({
        message_id: "msg_stop_y",
        notice: true,
        notice_reason: "finished",
        body: "body of msg_stop_y",
      }),
      expect.objectContaining({
        message_id: "msg_follow",
        notice: true,
        notice_reason: "timeout",
      }),
      expect.objectContaining({
        message_id: "msg_plain",
        notice: false,
        notice_reason: null,
      }),
      expect.objectContaining({
        message_id: "msg_odd",
        notice: false,
        notice_reason: null,
      }),
    ]);
    const outcome = await answer([sendOk("msg_stop_y")], "msg_stop_y", "N");
    expect(outcome).toMatchObject({
      ok: true,
      result: { transport: "thread" },
    });
  });

  test("a long body is cut on the delivery and flagged", async () => {
    const long = "x".repeat(8001);
    const result = await check([ask("msg_long", { body: long })]);
    expect(result.questions[0]).toMatchObject({
      body: "x".repeat(8000),
      body_truncated: true,
    });
  });

  test("refusals write nothing and call nothing", async () => {
    await check([ask("msg_q")]);
    const cases: [string, Partial<ReplyInput>, string][] = [
      ["msg_none", {}, "task_not_ready"],
      ["msg_q", { generation: 2 }, "owner_generation_stale"],
      ["msg_q", { host: "other" }, "wrong_host"],
    ];
    for (const [message, over, code] of cases)
      expect(await quiet(message, "T", over)).toMatchObject({
        ok: false,
        refusal: { code },
      });

    await conn.sql`update ledger.dispatch set role = 'decider' where dispatch_id = 'ctx_1'`;
    expect(await quiet("msg_q", "T")).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message: expect.stringContaining("pod decide"),
      },
    });
    await conn.sql`update ledger.dispatch set role = 'developer', settlement = 'done' where dispatch_id = 'ctx_1'`;
    expect(await quiet("msg_q", "T")).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message: "Dispatch ctx_1 is settled done; nothing waits for an answer",
      },
    });
    expect(await events(conn, "reply")).toEqual([]);
    expect(
      await conn.db.listOperations(["reply"], ["pending", "unknown", "done"]),
    ).toEqual([]);
  });

  test("a decision_gate message is not a question", async () => {
    await check([ask("msg_gate", { type: "decision_gate" })]);
    expect(await quiet("msg_gate", "T")).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready" },
    });
    expect((await check()).questions).toEqual([]);
  });

  test("a failed reply leaves the operation unknown, and a rerun after answer_conflict sends on the thread", async () => {
    await check([ask("msg_q")]);
    const failed = await answer(
      [{ verb: "reply", argv: ["--id", "msg_q"], exitCode: 1, stdout: "" }],
      "msg_q",
      "T",
    );
    expect(failed).toMatchObject({ ok: false, refusal: { code: "failed" } });
    const [operation] = await conn.db.listOperations(["reply"], ["unknown"]);
    expect(operation).toBeDefined();
    const unknown = await check();
    expect(unknown.nextSteps).toContain(
      `reply to msg_q on ctx_1 is unknown (op ${operation?.op_key}): rerun pod reply --message msg_q --generation 1 FILE with the same FILE`,
    );
    expect(await quiet("msg_q", "other text")).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message: expect.stringContaining("is unknown"),
      },
    });

    const outcome = await answer(
      [
        refusedReply("reply", "answer_conflict", ["--id", "msg_q"]),
        sendOk("msg_q", ["--thread-id", "msg_q"]),
      ],
      "msg_q",
      "T",
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { transport: "thread", answered_elsewhere: true },
    });
    expect((await sentArgv()).at(-1)).toEqual(
      expect.arrayContaining([
        "send",
        "--thread-id",
        "msg_q",
        "--from",
        coordinator,
      ]),
    );
    expect((await events(conn, "reply")).map((row) => row.payload)).toEqual([
      expect.objectContaining({
        question_id: "msg_q",
        transport: "thread",
        answered_elsewhere: true,
      }),
    ]);
    expect((await check()).questions).toEqual([]);
  });

  test("a fresh answer_conflict sends the same text on the thread", async () => {
    await check([ask("msg_q")]);
    const outcome = await answer(
      [
        refusedReply("reply", "answer_conflict", ["--id", "msg_q"]),
        sendOk("msg_q", ["--thread-id", "msg_q"]),
      ],
      "msg_q",
      "T",
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { transport: "thread", answered_elsewhere: true },
    });
  });
});
