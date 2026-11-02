import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { ok } from "../orca/temp-fixtures.ts";
import {
  ack,
  applyConfig,
  audit,
  auditor,
  cliReplay,
  cliXlRun,
  decideArgs,
  decider,
  delivery,
  generation,
  oneSlotHome,
  planTask,
  proposal,
  questionFile,
  run,
  sent,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { batch, empty, message, started, workers } from "../db/run-fixture.ts";

const dir = "test/replay/xl-coordinator-pair";
const planner = "ctx_plan";
describeDb("xl-coordinator-pair", () => {
  let conn: Connection;
  const env = { POD_HOME: oneSlotHome() };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig([
      `${dir}/policy.yaml`,
      `${dir}/crew.yaml`,
      `${dir}/process.yaml`,
      "specs/decision/default.yaml",
    ]);
  });
  afterAll(() => conn.close());

  async function activity(dispatchId: string) {
    return (await conn.db.getDispatch(dispatchId))?.activity;
  }

  async function sendTargets() {
    const rows = await conn.sql<{ argv: string[] }[]>`
      select payload -> 'argv' as argv from ledger.event
      where type = 'receipt' and payload ->> 'verb' = 'send' order by id`;
    return rows.map(({ argv }) => argv[argv.indexOf("--to") + 1]);
  }

  async function seatOps() {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation where intent = 'decide_seat'`;
    return row?.n ?? 0;
  }

  test("impl-xlarge@1 at capacity 1: the pair opens at Run start, the slot passes to the worker, and the plan is a Decision round", async () => {
    const created = await cliXlRun(conn, "TRK-1", env);
    expect(created).toMatchObject({
      state: "active",
      coordinator_dispatch_id: decider,
      auditor_dispatch_id: auditor,
    });
    expect([await activity(decider), await activity(auditor)]).toEqual([
      "running",
      "waiting",
    ]);

    const launched = await cliReplay(
      conn,
      ["dispatch", "--task", planTask, "--seat", "plan-1", ...generation],
      [ok("worker-start", started(planner, planTask))],
      env,
    );
    expect(launched.status, launched.json.error?.message).toBe(0);
    expect([
      await activity(decider),
      await activity(planner),
      await activity(auditor),
    ]).toEqual(["waiting", "running", "waiting"]);
    const [handoff] = await conn.sql<{ waiting: string }[]>`
      select result_ref ->> 'coordinator_waiting' as waiting
      from ledger.operation where intent = 'dispatch'`;
    expect(handoff?.waiting).toBe(decider);

    const delivered = await cliReplay(
      conn,
      ["check", ...run, ...generation],
      [
        ok(
          "check",
          batch("delivery_plan", [
            message("msg_plan", "worker_done", {
              taskId: planTask,
              dispatchId: planner,
              outcome: "succeeded",
            }),
          ]),
          run,
        ),
        ok("check", empty("delivery_plan"), ack("delivery_plan")),
        ok(
          "worker-list",
          workers([
            { dispatchId: planner, taskId: planTask, workerState: "succeeded" },
          ]),
          run,
        ),
      ],
      env,
    );
    expect(delivered.status, delivered.json.error?.message).toBe(0);
    expect((await conn.db.getTask(planTask))?.state).toBe("delivered");
    expect([await activity(planner), await activity(auditor)]).toEqual([
      "settled",
      "waiting",
    ]);
    expect(await sendTargets()).toEqual([]);

    const decided = await cliReplay(
      conn,
      decideArgs(
        questionFile({
          question: "Which rollout should the plan use?",
          options: ["one release", "two releases with a rollback step"],
        }),
      ),
      [sent(decider)],
      env,
    );
    expect(decided.status, decided.json.error?.message).toBe(0);
    expect(decided.json.result).toMatchObject({
      state: "round:1",
      decider_dispatch_id: decider,
    });
    const id = String(decided.json.result?.["decision_id"]);

    const proposed = await cliReplay(
      conn,
      ["check", ...run, ...generation],
      delivery("delivery_p1", [proposal("p1", id, 1)], [sent(auditor)]),
      env,
    );
    expect(proposed.status, proposed.json.error?.message).toBe(0);
    const agreed = await cliReplay(
      conn,
      ["check", ...run, ...generation],
      delivery("delivery_a1", [audit("a1", id, 1, "agree")]),
      env,
    );
    expect(agreed.status, agreed.json.error?.message).toBe(0);
    expect((await conn.db.getDecision(id))?.state).toBe("agreed");
    const decisions = await conn.sql<
      { task_id: string; payload: Record<string, unknown> }[]
    >`select task_id, payload from ledger.event where type = 'decision'`;
    expect(decisions).toEqual([
      {
        task_id: planTask,
        payload: expect.objectContaining({
          decision_id: id,
          effect: "accept_plan",
          outcome: "agreed",
          rounds: 1,
        }),
      },
    ]);
    const rounds = await conn.sql`
      select round, stance, decider_dispatch_id, auditor_dispatch_id
      from ledger.decision_round where decision_id = ${id}`;
    expect(rounds).toEqual([
      {
        round: 1,
        stance: "agree",
        decider_dispatch_id: decider,
        auditor_dispatch_id: auditor,
      },
    ]);
    const [receipts] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.gate_receipt`;
    expect(receipts?.n).toBe(0);
    expect(await seatOps()).toBe(2);
    expect(await sendTargets()).toEqual([
      `dispatch:${decider}`,
      `dispatch:${auditor}`,
    ]);
    expect((await conn.db.getTask(planTask))?.state).toBe("done");
    expect((await conn.db.getTask("task_implement"))?.state).toBe("ready");
  });
});
