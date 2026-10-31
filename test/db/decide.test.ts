import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import { noCalls, ok, unknownReply } from "../orca/temp-fixtures.ts";
import {
  decideInput,
  decider,
  deliveredPlan,
  implementTask,
  opened,
  planTask,
  seatStarted,
  seatTask,
  sent,
} from "./decision-fixture.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { replay } from "./run-fixture.ts";

describeDb("pod decide", () => {
  let conn: Connection;
  let templates: Revision;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    templates = await deliveredPlan(conn);
  });
  afterAll(() => conn.close());

  async function decide(
    entries: Parameters<typeof replay>[1],
    over: Parameters<typeof decideInput>[1] = {},
    revision: Revision | null = templates,
  ) {
    if (entries.length === 0) {
      const { log } = replay(conn, []);
      return openDecision(conn.db, noCalls(), log, decideInput(revision, over));
    }
    const { orca, log } = replay(conn, entries);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(revision, over),
    );
    orca.assertDone();
    return outcome;
  }

  test("an open pins the manifest, moves to round 1, opens the decider, and sends round 1", async () => {
    const id = await opened(conn, templates);
    const decision = await conn.db.getDecision(id);
    expect(decision).toMatchObject({
      id,
      run_id: "run_1",
      task_id: planTask,
      category: "architecture_choice",
      effect: "accept_plan",
      state: "round:1",
      binding: "run",
      budget: {
        wall_clock: "2h",
        relaunches: 2,
        tool_calls: 40,
        context_tokens: "60k",
      },
      spent: { wall_clock: 0, relaunches: 0, tool_calls: 0, context_tokens: 0 },
      closed_at: null,
    });
    expect(id).toMatch(/^dec_[0-9a-f]{64}$/);
    const manifest = await conn.db.getManifest(decision?.manifest_id ?? "");
    expect(manifest).toMatchObject({ decision_id: id, task_id: planTask });
    const sources = (manifest?.references as { source: string }[]).map(
      (row) => row.source,
    );
    expect(sources).toEqual([
      "story",
      "run",
      "task",
      "crew",
      "process",
      "policy",
      "delivery",
    ]);
    expect(await conn.db.getDispatch(decider)).toMatchObject({
      task_id: null,
      decision_id: id,
      role: "decider",
      seat: "dec-1",
      activity: "running",
      settlement: "open",
    });
    const ops = await conn.sql<{ intent: string; status: string }[]>`
      select intent, status from ledger.operation
      where intent in ('decide', 'decide_seat') order by intent`;
    expect(ops).toEqual([
      { intent: "decide", status: "done" },
      { intent: "decide_seat", status: "done" },
    ]);
  });

  test("the same op key replays the result with no Orca call", async () => {
    const id = await opened(conn, templates);
    const { log } = replay(conn, []);
    const again = await openDecision(
      conn.db,
      noCalls(),
      log,
      decideInput(templates),
    );
    expect(again).toMatchObject({ ok: true, result: { decision_id: id } });
  });

  test("no active decision Revision is revision_not_found naming the apply", async () => {
    const outcome = await decide([], {}, null);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "revision_not_found",
        nextSteps: [
          "pod config apply specs/decision/default.yaml --activate --scope global --expected-revision none",
        ],
      },
    });
  });

  test("a Task that is not delivered is task_not_ready", async () => {
    const outcome = await decide([], { task: implementTask });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready" },
    });
  });

  test("a delivered Task whose step has no decision is task_not_ready", async () => {
    await conn.sql`update ledger.task set state = 'delivered' where task_id = ${implementTask}`;
    const outcome = await decide([], { task: implementTask });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message: `Task ${implementTask} step implement has no decision`,
      },
    });
  });

  test("a stale generation is owner_generation_stale and is recorded", async () => {
    const outcome = await decide([], { generation: 2 });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    const [row] = await conn.sql<{ status: string }[]>`
      select status from ledger.operation where intent = 'decide'`;
    expect(row?.status).toBe("refused");
  });

  test("a second open Decision on the Task is duplicate_op", async () => {
    await opened(conn, templates);
    const outcome = await decide([], { opKey: "decide:other" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
  });

  test("an unknown seat launch keeps spec and requestId, moves no Task, and a rerun does not relaunch", async () => {
    const first = await decide([
      seatTask("decider"),
      unknownReply("worker-start", "req_seat"),
    ]);
    expect(first).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    const [seat] = await conn.sql<
      { status: string; result_ref: Record<string, unknown> }[]
    >`select status, result_ref from ledger.operation where intent = 'decide_seat'`;
    expect(seat?.status).toBe("unknown");
    expect(seat?.result_ref).toMatchObject({
      requestId: "req_seat",
      orca_task: "orca_decider",
      spec: expect.stringContaining("decider Seat"),
      request: { role: "decider", seat: "dec-1", host: "local" },
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("delivered");
    const holds =
      await conn.sql`select 1 from ledger.event where type = 'hold'`;
    expect(holds).toHaveLength(0);
    const again = await decide([
      ok("request-show", { requestId: "req_seat", state: "pending" }),
    ]);
    expect(again).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        nextSteps: [expect.stringMatching(/^pod check/), "pod check"],
      },
    });
  });

  test("a failed round 1 send leaves the op pending, and a rerun sends once with the open Seat", async () => {
    const first = await decide([
      seatTask("decider"),
      ok("worker-start", seatStarted(decider)),
      {
        verb: "send",
        exitCode: 1,
        stdout: '{"ok":false,"error":{"code":"boom"}}',
      },
    ]);
    expect(first).toMatchObject({ ok: false, refusal: { code: "failed" } });
    const again = await decide([sent(decider)]);
    expect(again).toMatchObject({ ok: true, result: { state: "round:1" } });
    const starts =
      await conn.sql`select 1 from ledger.dispatch where role = 'decider'`;
    expect(starts).toHaveLength(1);
  });

  test("the CLI refuses --effect change_spec as a usage error naming S12b", () => {
    const result = runCli([
      "decide",
      "--task",
      planTask,
      "--category",
      "architecture_choice",
      "--effect",
      "change_spec",
      "question.yaml",
      "--generation",
      "1",
    ]);
    expect(result.json.error?.code).toBe("usage");
    expect(result.json.error?.message).toContain("S12b");
  });
});
