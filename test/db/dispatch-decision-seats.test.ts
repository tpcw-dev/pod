import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import { lost, noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import {
  ack,
  checkInput,
  decideInput,
  deliveredPlan,
  proposal,
  refusedReply,
  run,
  seatTask,
  sent,
} from "./decision-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { batch, empty, events, replay, workers } from "./run-fixture.ts";

const fallbackCrew = {
  seats: [
    { id: "plan-1", roles: ["planner"], runtime: "claude", model: "m-1" },
    { id: "dev-1", roles: ["developer"], runtime: "claude", model: "m-1" },
    {
      id: "dec-1",
      roles: ["decider"],
      runtime: "pod-unregistered-agent",
      model: "m-2",
      fallback: "dec-fb",
    },
    {
      id: "dec-fb",
      roles: ["decider-fallback"],
      runtime: "claude",
      model: "m-4",
    },
    {
      id: "aud-1",
      roles: ["auditor"],
      runtime: "codex",
      independent_of: ["dec-1", "dec-fb"],
      fallback: "aud-fb",
    },
    {
      id: "aud-fb",
      roles: ["auditor-fallback"],
      runtime: "claude",
      model: "m-5",
      independent_of: ["dec-1", "dec-fb"],
    },
  ],
};

const noFallbackCrew = {
  seats: fallbackCrew.seats.map((seat) =>
    Object.fromEntries(
      Object.entries(seat).filter(([key]) => key !== "fallback"),
    ),
  ),
};

function startedOn(dispatchId: string, agent: string, model: string) {
  return {
    dispatchId,
    state: "ready",
    taskId: `orca_${dispatchId}`,
    terminalHandle: `term_${dispatchId}`,
    launch: {
      requested: { agent, model },
      effective: { agent, model },
    },
  };
}

const refusedStart = (task: string) =>
  refusedReply("worker-start", "agent_not_found", ["--task", task]);

describeDb("decision Seats fall back", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function decide(templates: Revision, entries: TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates),
    );
    orca.assertDone();
    return outcome;
  }

  async function seatOps() {
    return conn.sql<{ status: string; request: Record<string, unknown> }[]>`
      select status, result_ref -> 'request' as request from ledger.operation
      where intent = 'decide_seat' order by created_at, op_key`;
  }

  test("a refused decider launch opens the fallback Seat, marks the start fallback_of, and records the primary refused", async () => {
    const templates = await deliveredPlan(conn, { gates: [] }, fallbackCrew);
    const outcome = await decide(templates, [
      seatTask("decider"),
      refusedStart("orca_decider"),
      ok("task-create", { task: { id: "orca_fb", status: "ready" } }),
      ok("worker-start", startedOn("ctx_fb", "claude", "m-4"), [
        "--task",
        "orca_fb",
        "--agent",
        "claude",
        "--model",
        "m-4",
      ]),
      sent("ctx_fb"),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { decider_dispatch_id: "ctx_fb", state: "round:1" },
    });
    const dispatch = await conn.db.getDispatch("ctx_fb");
    expect(dispatch).toMatchObject({
      seat: "dec-fb",
      role: "decider",
      requested_launch: { agent: "claude", model: "m-4" },
    });
    const [start] = (await events(conn, "start")).filter(
      (row) => row.dispatch_id === "ctx_fb",
    );
    expect(start?.payload).toMatchObject({
      seat: "dec-fb",
      fallback_of: "dec-1",
    });
    const ops = await seatOps();
    expect(ops).toHaveLength(2);
    expect(ops.find((row) => row.request["seat"] === "dec-1")?.status).toBe(
      "refused",
    );
    expect(ops.find((row) => row.request["seat"] === "dec-fb")).toMatchObject({
      status: "done",
      request: {
        fallback_of: "dec-1",
        primary_refusal: { code: "failed" },
      },
    });
  });

  test("the auditor's independence is checked against the fallback decider, and a refused auditor opens its fallback", async () => {
    const templates = await deliveredPlan(conn, { gates: [] }, fallbackCrew);
    const decided = await decide(templates, [
      seatTask("decider"),
      refusedStart("orca_decider"),
      ok("task-create", { task: { id: "orca_fb", status: "ready" } }),
      ok("worker-start", startedOn("ctx_fb", "claude", "m-4")),
      sent("ctx_fb"),
    ]);
    if (!decided.ok) throw new Error(decided.refusal.message);
    const id = decided.result.decision_id;
    const { orca, log } = replay(conn, [
      ok("check", batch("d1", [proposalFrom("ctx_fb", id)]), run),
      ok("check", empty("d1"), ack("d1")),
      seatTask("auditor"),
      refusedStart("orca_auditor"),
      ok("task-create", { task: { id: "orca_afb", status: "ready" } }),
      ok("worker-start", startedOn("ctx_afb", "claude", "m-5")),
      sent("ctx_afb"),
      ok("worker-list", workers([]), run),
    ]);
    const checked = await checkPass(conn.db, orca, null, log, checkInput());
    orca.assertDone();
    if (!checked.ok) throw new Error(checked.refusal.message);
    expect(await conn.db.getDispatch("ctx_afb")).toMatchObject({
      seat: "aud-fb",
      role: "auditor",
    });
  });

  test("a refused decider launch with no fallback moves the Decision to needs_human with runtime-failure", async () => {
    const templates = await deliveredPlan(conn, { gates: [] }, noFallbackCrew);
    const outcome = await decide(templates, [
      seatTask("decider"),
      refusedStart("orca_decider"),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "failed" } });
    if (outcome.ok) return;
    const [decision] = await conn.sql<{ id: string }[]>`
      select id from ledger.decision`;
    expect(outcome.refusal.nextSteps).toContain(
      `Decision ${decision?.id} is needs_human: runtime-failure`,
    );
    expect(await conn.db.getDecision(decision?.id ?? "")).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
    });
    expect(
      await conn.sql`select 1 from ledger.dispatch where decision_id is not null`,
    ).toHaveLength(0);
    expect((await events(conn, "decision"))[0]?.payload).toMatchObject({
      outcome: "needs_human",
      reason: "runtime-failure",
    });
  });

  test("a lost decider launch reply is launch_unknown and does not fall back", async () => {
    const templates = await deliveredPlan(conn, { gates: [] }, fallbackCrew);
    const outcome = await decide(templates, [
      seatTask("decider"),
      lost("worker-start", ["--task", "orca_decider"]),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    const ops = await seatOps();
    expect(ops.map((row) => row.status)).toEqual(["unknown"]);
    expect(
      (
        await conn.sql<{ state: string }[]>`select state from ledger.decision`
      )[0]?.state,
    ).toBe("round:1");
  });

  test("a quota refusal of the primary tries the fallback Seat", async () => {
    const templates = await deliveredPlan(conn, { gates: [] }, fallbackCrew);
    const { log } = replay(conn, []);
    const outcome = await openDecision(
      conn.db,
      noCalls(),
      log,
      decideInput(templates, { capacity: 0 }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
    const ops = await seatOps();
    expect(ops.map((row) => [row.request["seat"], row.status])).toEqual([
      ["dec-1", "refused"],
      ["dec-fb", "refused"],
    ]);
  });
});

function proposalFrom(dispatchId: string, decisionId: string): unknown {
  const body = proposal("p1", decisionId, 1) as { payload: string };
  const payload = JSON.parse(body.payload) as Record<string, unknown>;
  return { ...body, payload: JSON.stringify({ ...payload, dispatchId }) };
}
