import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, checkWait } from "../../src/core/check/check.ts";
import { cancelDecision } from "../../src/core/decide/advance.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import {
  lost,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import {
  ack,
  audit,
  auditor,
  checkInput,
  decideInput,
  decider,
  deliveredPlan,
  implementTask,
  opened,
  planTask,
  proposal,
  run,
  seatStarted,
  sent,
} from "./decision-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { batch, empty, events, replay, workers } from "./run-fixture.ts";

describeDb("pod check advances a Decision", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function start(policy?: Json): Promise<string> {
    return opened(conn, await deliveredPlan(conn, policy));
  }

  function delivery(n: number, messages: unknown[], after: TempEntry[] = []) {
    const id = `delivery_d${n}`;
    return [
      ok("check", batch(id, messages), run),
      ok("check", empty(id), ack(id)),
      ...after,
      ok("worker-list", workers([]), run),
    ];
  }

  async function pass(entries: TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, null, log, checkInput());
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result;
  }

  const opensAuditor = [
    ok("worker-start", seatStarted(auditor, "m-3")),
    sent(auditor),
  ];

  async function rounds(conn: Connection, id: string) {
    return conn.sql<
      {
        round: number;
        stance: string;
        decider_dispatch_id: string;
        auditor_dispatch_id: string;
      }[]
    >`select round, stance, decider_dispatch_id, auditor_dispatch_id
      from ledger.decision_round where decision_id = ${id} order by round`;
  }

  test("disagree then agree runs two rounds on the same two Dispatches, passes the plan Task, and readies implement", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    expect(await conn.db.getDispatch(auditor)).toMatchObject({
      task_id: null,
      decision_id: id,
      role: "auditor",
      activity: "running",
    });
    expect((await conn.db.getDispatch(decider))?.activity).toBe("waiting");
    await pass(delivery(2, [audit("a1", id, 1, "disagree")], [sent(decider)]));
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
    await pass(delivery(3, [proposal("p2", id, 2)], [sent(auditor)]));
    await pass(delivery(4, [audit("a2", id, 2, "agree")]));

    expect(await rounds(conn, id)).toEqual([
      {
        round: 1,
        stance: "disagree",
        decider_dispatch_id: decider,
        auditor_dispatch_id: auditor,
      },
      {
        round: 2,
        stance: "agree",
        decider_dispatch_id: decider,
        auditor_dispatch_id: auditor,
      },
    ]);
    const decision = await conn.db.getDecision(id);
    expect(decision).toMatchObject({
      state: "agreed",
      reason: "agreed",
      outcome: { result: "agreed", text: "round 2 proposal" },
      closed_at: expect.any(Date),
    });
    const decided = await events(conn, "decision");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toEqual({
      decision_id: id,
      manifest_id: decision?.manifest_id,
      rounds: 2,
      outcome: "agreed",
      reason: "agreed",
      effect: "accept_plan",
      stance_history: [
        { round: 1, stance: "disagree" },
        { round: 2, stance: "agree" },
      ],
    });
    const outcomes = await events(conn, "outcome");
    expect(outcomes.at(-1)?.payload).toMatchObject({
      task_id: planTask,
      outcome: "agreed",
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("done");
    expect((await conn.db.getTask(implementTask))?.state).toBe("ready");
  });

  test("disagree at a round bound of 1 goes to needs_human with disagreement and leaves the plan Task delivered", async () => {
    const id = await start({ gates: [], limits: { decision_rounds: 1 } });
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "disagree")]));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "disagreement",
    });
    const [decided] = await events(conn, "decision");
    expect(decided?.payload).toMatchObject({
      outcome: "needs_human",
      reason: "disagreement",
      rounds: 1,
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("delivered");
    expect((await conn.db.getDispatch(decider))?.activity).toBe("waiting");
    expect((await conn.db.getDispatch(auditor))?.activity).toBe("waiting");
  });

  test("escalate goes to needs_human with context-missing, and a later audit is ignored as settled_decision", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "escalate")]));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "context-missing",
    });
    expect(await rounds(conn, id)).toMatchObject([{ stance: "escalate" }]);
    const result = await pass(delivery(3, [audit("a2", id, 1, "agree")]));
    expect(result.ignored).toBe(1);
    const [ignored] = await events(conn, "ignored");
    expect(ignored?.payload).toMatchObject({ reason: "settled_decision" });
  });

  test("needs_evidence goes to needs_human with context-missing and writes no round row", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "needs_evidence")]));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "context-missing",
    });
    expect(await rounds(conn, id)).toEqual([]);
  });

  test("a proposal with no citation is an automatic disagree whatever the auditor says", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1, [])], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "agree")], [sent(decider)]));
    expect(await rounds(conn, id)).toMatchObject([{ stance: "disagree" }]);
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
  });

  test("an audit before the round's proposal, or for another round, is ignored as out_of_turn", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "disagree")], [sent(decider)]));
    const early = await pass(delivery(3, [audit("a2", id, 2, "agree")]));
    expect(early.ignored).toBe(1);
    const wrong = await pass(delivery(4, [proposal("p3", id, 3)]));
    expect(wrong.ignored).toBe(1);
    const reasons = (await events(conn, "ignored")).map(
      (row) => row.payload["reason"],
    );
    expect(reasons).toEqual(["out_of_turn", "out_of_turn"]);
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
  });

  test("a malformed decision payload is ignored as malformed_decision", async () => {
    const id = await start();
    const result = await pass(delivery(1, [proposal("p1", id, 7)]));
    expect(result.ignored).toBe(1);
    const [ignored] = await events(conn, "ignored");
    expect(ignored?.payload).toMatchObject({ reason: "malformed_decision" });
  });

  test("a cancel moves the Decision to cancelled and the plan Task to hold", async () => {
    const id = await start();
    await conn.db.transaction((tx) =>
      cancelDecision(tx, { decision: id, at: new Date(), host: "local" }),
    );
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "cancelled",
      reason: "cancelled",
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("hold");
    const [decided] = await events(conn, "decision");
    expect(decided?.payload).toMatchObject({ outcome: "cancelled" });
  });

  test("pod check --wait --decision keeps passing until the Decision settles", async () => {
    const id = await start({ gates: [], limits: { decision_rounds: 1 } });
    const slept: number[] = [];
    const { orca, log } = replay(conn, [
      ...delivery(1, [proposal("p1", id, 1)], opensAuditor),
      ...delivery(2, [audit("a1", id, 1, "agree")]),
    ]);
    const outcome = await checkWait(conn.db, orca, null, log, {
      ...checkInput(),
      decision: id,
      interval: 5,
      timeout: 60,
      sleep: async (seconds) => {
        slept.push(seconds);
      },
    });
    orca.assertDone();
    expect(outcome).toMatchObject({ ok: true });
    expect(slept).toEqual([5]);
    expect((await conn.db.getDecision(id))?.state).toBe("agreed");
  });

  async function unknownSeat(reply: TempEntry): Promise<void> {
    const templates = await deliveredPlan(conn);
    const { orca, log } = replay(conn, [reply]);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates),
    );
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
  }

  test("an unknown decider launch with a request id is retried by spec when request-show completes, and pod decide then sends round 1", async () => {
    await unknownSeat(unknownReply("worker-start", "req_seat"));
    const result = await pass([
      ok("request-show", { requestId: "req_seat", state: "completed" }),
      ok("worker-start", seatStarted(decider), ["--retry-request", "req_seat"]),
      ok("check", empty(), run),
      ok("worker-list", workers([]), run),
    ]);
    expect(result.reconciled).toEqual([
      { op_key: expect.stringMatching(/^decide_seat:/), to: "running" },
    ]);
    expect(await conn.db.getDispatch(decider)).toMatchObject({
      task_id: null,
      role: "decider",
      activity: "running",
    });
    const templates = await conn.db.getRevisionByRef("decision", "default", 1);
    const { orca, log } = replay(conn, [sent(decider)]);
    const again = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates),
    );
    orca.assertDone();
    expect(again).toMatchObject({ ok: true, result: { state: "round:1" } });
  });

  test("an unknown decider launch with no request id stays unknown and prints its op key", async () => {
    await unknownSeat(lost("worker-start"));
    const result = await pass([
      ok("check", empty(), run),
      ok("worker-list", workers([]), run),
    ]);
    expect(result.reconciled).toEqual([]);
    expect(result.nextSteps).toContainEqual(
      expect.stringMatching(
        /^pod check: Decision Seat launch decide_seat:\S+ is unknown \(no request id recorded\)/,
      ),
    );
  });
});
