import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, checkWait } from "../../src/core/check/check.ts";
import { cancelDecision, failDecision } from "../../src/core/decide/advance.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Db } from "../../src/core/ports/db.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { supersededWorktree } from "../../src/core/dispatch/retry.ts";
import {
  replacementOpKey,
  supersedeOpKey,
} from "../../src/core/process/project.ts";
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
  dispatchedPlan,
  evidence,
  implementTask,
  opened,
  planTask,
  planner,
  proposal,
  refusedReply,
  run,
  seatStarted,
  seatTask,
  sent,
  taskSpec,
} from "./decision-fixture.ts";
import { fakeTracker, trackerStory, type FakeTracker } from "./fake-tracker.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  batch,
  dispatchInput,
  empty,
  events,
  replay,
  started,
  workers,
} from "./run-fixture.ts";

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
    seatTask("auditor"),
    ok("worker-start", seatStarted(auditor, "m-3"), ["--task", "orca_auditor"]),
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

  test("escalate below the bound records the round and sends the decider round_next", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(delivery(2, [audit("a1", id, 1, "escalate")], [sent(decider)]));
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
    expect(await rounds(conn, id)).toMatchObject([{ stance: "escalate" }]);
    expect((await conn.db.getDispatch(decider))?.activity).toBe("running");
  });

  test("needs_evidence waits for evidence, which joins a child manifest the next audit cites", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    const pinned = (await conn.db.getDecision(id))?.manifest_id;
    await pass(
      delivery(2, [audit("a1", id, 1, "needs_evidence")], [sent(decider)]),
    );
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "awaiting_evidence:1",
      spent: expect.objectContaining({ tool_calls: 1 }),
    });
    expect(await rounds(conn, id)).toEqual([]);
    const empty = await pass(delivery(3, [evidence("e0", id, 1, [])]));
    expect(empty.nextSteps).toContainEqual(
      expect.stringMatching(/^ignored decision_evidence for Decision/),
    );
    expect((await conn.db.getDecision(id))?.state).toBe("awaiting_evidence:1");
    await pass(delivery(4, [evidence("e1", id, 1)], [sent(auditor)]));
    const decision = await conn.db.getDecision(id);
    expect(decision?.state).toBe("round:1");
    expect(decision?.manifest_id).not.toBe(pinned);
    const child = await conn.db.getManifest(decision?.manifest_id ?? "");
    expect(child?.parent_id).toBe(pinned);
    expect(child?.references).toContainEqual(
      expect.objectContaining({ source: "git_status", revision: "abc123" }),
    );
    await pass(delivery(5, [audit("a2", id, 1, "agree")]));
    expect((await conn.db.getDecision(id))?.state).toBe("agreed");
    const [row] = await conn.sql<{ manifest_id: string }[]>`
      select manifest_id from ledger.decision_round where decision_id = ${id}`;
    expect(row?.manifest_id).toBe(decision?.manifest_id);
  });

  test("evidence that cites a policy or a task reference is not a changed dependency, and the next agree applies", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    await pass(
      delivery(2, [audit("a1", id, 1, "needs_evidence")], [sent(decider)]),
    );
    await pass(
      delivery(
        3,
        [
          evidence("e1", id, 1, [
            { source: "policy", revision: "policy-v2", excerpt: "the gates" },
            { source: "task", revision: "task-note", excerpt: "prose note" },
          ]),
        ],
        [sent(auditor)],
      ),
    );
    await pass(delivery(4, [audit("a2", id, 1, "agree")]));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "agreed",
      reason: "agreed",
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("done");
  });

  test("a round_next send that fails stays owed, and the next pass with no delivery sends it once", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    const failed = await pass(
      delivery(
        2,
        [audit("a1", id, 1, "disagree")],
        [refusedReply("send", "failed", ["--to", `dispatch:${decider}`])],
      ),
    );
    expect(failed.nextSteps).toContainEqual(
      expect.stringContaining(`stays waiting`),
    );
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
    await pass([
      ok("check", empty("delivery_quiet"), run),
      sent(decider),
      ok("worker-list", workers([]), run),
    ]);
    expect((await conn.db.getDispatch(decider))?.activity).toBe("running");
    await pass([
      ok("check", empty("delivery_quiet_2"), run),
      ok("worker-list", workers([]), run),
    ]);
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
    const { orca, log } = replay(conn, [seatTask("decider"), reply]);
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
      ok("worker-start", seatStarted(decider), [
        "--task",
        "orca_decider",
        "--retry-request",
        "req_seat",
      ]),
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

describeDb("pod check applies a change_spec Decision", () => {
  let conn: Connection;
  const replacement = "task_plan_2";
  const lineage = "run_1:plan";

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function pass(entries: TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, null, log, checkInput());
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result;
  }

  async function openChangeSpec(
    task = planTask,
    spec?: string,
    seat: TempEntry[] = [
      seatTask("decider"),
      ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
    ],
  ) {
    const templates = await conn.db.getRevisionByRef("decision", "default", 1);
    const row = await conn.db.getTask(task);
    if (row === null) throw new Error(`no Task ${task}`);
    const { orca, log } = replay(conn, [...seat, sent(decider)]);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates, {
        task,
        effect: "change_spec",
        spec: taskSpec(row, spec),
      }),
    );
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result.decision_id;
  }

  const opensAuditor = [
    seatTask("auditor"),
    ok("worker-start", seatStarted(auditor, "m-3"), ["--task", "orca_auditor"]),
    sent(auditor),
  ];

  function agreeBatch(id: string, n = 2) {
    const key = `delivery_cs${n}`;
    return [
      ok("check", batch(key, [audit(`a${n}`, id, 1, "agree")]), run),
      ok("check", empty(key), ack(key)),
    ];
  }

  async function proposed(id: string) {
    await pass([
      ok("check", batch("delivery_cs1", [proposal("p1", id, 1)]), run),
      ok("check", empty("delivery_cs1"), ack("delivery_cs1")),
      ...opensAuditor,
      ok("worker-list", workers([]), run),
    ]);
  }

  const plannerRunning = ok(
    "worker-list",
    workers([
      { dispatchId: planner, taskId: planTask, workerState: "running" },
    ]),
    run,
  );
  const stopsPlanner = ok(
    "worker-stop",
    { dispatchId: planner, state: "stopped" },
    ["--dispatch", planner],
  );
  const createsReplacement = ok(
    "task-create",
    { task: { id: replacement, status: "ready" } },
    ["--run", "run_1"],
  );

  async function activation() {
    return conn.sql<{ revision_id: string }[]>`
      select revision_id from config.activation
      where scope = 'run' and scope_ref = 'run_1' and kind = 'task' and name = ${lineage}`;
  }

  async function supersedeOp(id: string) {
    return conn.db.getOperation(supersedeOpKey(id));
  }

  test("agreed activates the Revision, stops the waiting worker, supersedes the Task, and readies a replacement the dependent follows", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    expect((await conn.db.getDispatch(planner))?.activity).toBe("waiting");
    const decision = await conn.db.getDecision(id);
    const revision = (
      (await conn.db.getManifest(decision?.manifest_id ?? ""))?.references as {
        source: string;
        revision: string;
      }[]
    ).find((row) => row.source === "revision")?.revision;
    expect(revision).toBeDefined();
    await proposed(id);
    expect(await activation()).toEqual([]);

    await pass([
      ...agreeBatch(id),
      plannerRunning,
      stopsPlanner,
      createsReplacement,
    ]);

    expect((await conn.db.getDecision(id))?.state).toBe("agreed");
    expect(await activation()).toEqual([{ revision_id: revision }]);
    expect(await conn.db.getTask(planTask)).toMatchObject({
      state: "superseded",
    });
    expect(await conn.db.getTask(replacement)).toMatchObject({
      state: "ready",
      rework_of: planTask,
      lineage_id: lineage,
      step_id: "plan",
      spec_revision_id: revision,
    });
    expect((await conn.db.getTask(implementTask))?.deps).toEqual([replacement]);
    expect(await conn.db.getDispatch(planner)).toMatchObject({
      settlement: "superseded",
      activity: "settled",
    });
    const stops = await events(conn, "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      dispatch_id: planner,
      payload: {
        decision_id: id,
        receipt: { dispatchId: planner, state: "stopped" },
      },
    });
    const decided = await events(conn, "decision");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({
      decision_id: id,
      outcome: "agreed",
      effect: "change_spec",
      revision_id: revision,
      replacement_task_id: replacement,
    });
    expect((await supersedeOp(id))?.status).toBe("done");

    expect(await supersededWorktree(conn.db, replacement, "local")).toBe(
      "/w/one",
    );
    expect(await supersededWorktree(conn.db, replacement, "elsewhere")).toBe(
      null,
    );
    expect(await supersededWorktree(conn.db, implementTask, "local")).toBe(
      null,
    );
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_replacement", replacement)),
    ]);
    const launched = await dispatch(
      conn.db,
      orca,
      log,
      dispatchInput({
        task: replacement,
        seat: "plan-1",
        gitStatus: "## main\n M plan.md",
      }),
    );
    if (!launched.ok) throw new Error(launched.refusal.message);
    const view = await conn.db.getManifest(launched.result.manifest_id);
    expect(view?.references).toContainEqual(
      expect.objectContaining({
        source: "git_status",
        excerpt: "## main\n M plan.md",
      }),
    );
  });

  test("an agreed round after the Task's spec Revision changed ends needs_human context-missing with no supersede op", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    const {
      revision: { id: other },
    } = await conn.db.insertRevision(
      taskSpec(
        { lineage_id: lineage, run_id: "run_1" },
        "Another spec landed meanwhile.",
      ),
    );
    await conn.sql`update ledger.task set spec_revision_id = ${other}
      where task_id = ${planTask}`;
    await pass([...agreeBatch(id), ok("worker-list", workers([]), run)]);
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "context-missing",
    });
    expect(await supersedeOp(id)).toBeNull();
    const decided = await events(conn, "decision");
    expect(decided.at(-1)?.payload).toMatchObject({
      outcome: "needs_human",
      reason: "context-missing",
      changed: expect.stringMatching(/^task:/),
    });
  });

  test("a superseded agreed change_spec Decision never applies its spec, and the superseding Decision's op is the one followed", async () => {
    await dispatchedPlan(conn);
    const old = await openChangeSpec();
    await proposed(old);
    await pass([
      ...agreeBatch(old),
      plannerRunning,
      refusedReply("worker-stop", "runtime_busy", ["--dispatch", planner]),
    ]);
    expect((await supersedeOp(old))?.status).toBe("pending");
    const templates = await conn.db.getRevisionByRef("decision", "default", 1);
    const row = await conn.db.getTask(planTask);
    if (row === null) throw new Error("no plan Task");
    const later = taskSpec(row, "A later spec.");
    const { orca, log } = replay(conn, [sent(decider)]);
    const opened = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates, {
        effect: "change_spec",
        spec: later,
        supersedes: old,
      }),
    );
    orca.assertDone();
    if (!opened.ok) throw new Error(opened.refusal.message);
    const id = opened.result.decision_id;
    expect((await conn.db.getDecision(old))?.state).toBe("superseded");
    expect(await supersedeOp(old)).toMatchObject({
      status: "refused",
      result_ref: expect.objectContaining({ superseded_by: id }),
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");

    await pass([
      ok("check", batch("delivery_cs_b1", [proposal("pb1", id, 1)]), run),
      ok("check", empty("delivery_cs_b1"), ack("delivery_cs_b1")),
      sent(auditor),
      plannerRunning,
    ]);
    await pass([
      ok("check", batch("delivery_cs_b2", [audit("ab1", id, 1, "agree")]), run),
      ok("check", empty("delivery_cs_b2"), ack("delivery_cs_b2")),
      plannerRunning,
      stopsPlanner,
      createsReplacement,
    ]);
    expect(await activation()).toEqual([{ revision_id: later.id }]);
    expect((await supersedeOp(id))?.status).toBe("done");
    expect((await conn.db.getTask(planTask))?.state).toBe("superseded");
  });

  test("a failed worker-stop leaves the Task, the activation, and the op as they were, and the next pass finishes", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    const first = await pass([
      ...agreeBatch(id),
      plannerRunning,
      refusedReply("worker-stop", "runtime_busy", ["--dispatch", planner]),
    ]);
    expect(first.nextSteps.join("\n")).toContain(
      `worker-stop of Dispatch ${planner} failed: runtime_busy`,
    );
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");
    expect(await activation()).toEqual([]);
    expect(await events(conn, "decision")).toEqual([]);
    expect((await supersedeOp(id))?.status).toBe("pending");

    await pass([
      ok("check", empty(), run),
      plannerRunning,
      stopsPlanner,
      createsReplacement,
    ]);
    expect((await conn.db.getTask(planTask))?.state).toBe("superseded");
    expect((await conn.db.getTask(replacement))?.state).toBe("ready");
  });

  test("a worker-list showing the Dispatch stopped settles it with no worker-stop call", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    await pass([
      ...agreeBatch(id),
      ok(
        "worker-list",
        workers([
          { dispatchId: planner, taskId: planTask, workerState: "stopped" },
        ]),
        run,
      ),
      createsReplacement,
    ]);
    expect(await conn.db.getDispatch(planner)).toMatchObject({
      settlement: "superseded",
    });
    expect((await events(conn, "stop"))[0]?.payload).toMatchObject({
      worker_state: "stopped",
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("superseded");
  });

  test("an unknown worker-stop keeps its request id, and request-show completed settles it with no second stop", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    await pass([
      ...agreeBatch(id),
      plannerRunning,
      unknownReply("worker-stop", "req_stop", ["--dispatch", planner]),
    ]);
    expect((await supersedeOp(id))?.result_ref).toMatchObject({
      stop_request_id: "req_stop",
      stop_unknown: false,
    });
    await pass([
      ok("check", empty(), run),
      plannerRunning,
      ok("request-show", { requestId: "req_stop", state: "completed" }, [
        "--request",
        "req_stop",
      ]),
      createsReplacement,
    ]);
    expect((await events(conn, "stop"))[0]?.payload).toMatchObject({
      request_id: "req_stop",
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("superseded");
  });

  test("a failed replacement task-create leaves the Task as it was and the next pass creates under attempt 2", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    const first = await pass([
      ...agreeBatch(id),
      plannerRunning,
      stopsPlanner,
      refusedReply("task-create", "invalid_argument", ["--run", "run_1"]),
    ]);
    expect(first.nextSteps.join("\n")).toContain(
      "task-create for the replacement",
    );
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");
    expect((await conn.db.getRun("run_1"))?.state).toBe("active");
    expect((await supersedeOp(id))?.result_ref).toMatchObject({
      create_attempt: 2,
    });
    await pass([
      ok("check", empty(), run),
      createsReplacement,
      ok("worker-list", workers([]), run),
    ]);
    expect((await conn.db.getTask(planTask))?.state).toBe("superseded");
    expect((await conn.db.getTask(replacement))?.state).toBe("ready");
  });

  test("an unknown replacement task-create is read with request-show on the same key and never created twice", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    await pass([
      ...agreeBatch(id),
      plannerRunning,
      stopsPlanner,
      unknownReply("task-create", "req_create", ["--run", "run_1"]),
    ]);
    const second = await pass([
      ok("check", empty(), run),
      ok("request-show", { requestId: "req_create", state: "completed" }, [
        "--request",
        "req_create",
      ]),
      ok("worker-list", workers([]), run),
    ]);
    expect(second.nextSteps.join("\n")).toContain("has no known task id");
    expect((await supersedeOp(id))?.result_ref).toMatchObject({
      create_attempt: 1,
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");
  });

  test("a replacement project op another pass already holds makes no second task-create", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await proposed(id);
    const superseded = await conn.db.getTask(planTask);
    if (superseded === null) throw new Error("no plan Task");
    const held = replacementOpKey(superseded, 1);
    await conn.db.insertOperation({
      op_key: held,
      intent: "project",
      owner_generation: 1,
      at: new Date(),
    });
    const racing: Db = {
      ...conn.db,
      getOperation: (key) =>
        key === held ? Promise.resolve(null) : conn.db.getOperation(key),
    };
    const { orca, log } = replay(conn, [
      ...agreeBatch(id),
      plannerRunning,
      stopsPlanner,
    ]);
    const outcome = await checkPass(racing, orca, null, log, checkInput());
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const result = outcome.result;
    expect(result.nextSteps.join("\n")).toContain(
      "task-create for the replacement",
    );
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");
    expect((await supersedeOp(id))?.status).toBe("pending");
  });

  test("a second change_spec on the same lineage activates its own Revision over the first", async () => {
    await dispatchedPlan(conn);
    const first = await openChangeSpec();
    await proposed(first);
    await pass([
      ...agreeBatch(first),
      plannerRunning,
      stopsPlanner,
      createsReplacement,
    ]);
    const second = await openChangeSpec(
      replacement,
      "Plan it in two releases.",
      [],
    );
    const key = "delivery_cs3";
    await pass([
      ok("check", batch(key, [proposal("p3", second, 1)]), run),
      ok("check", empty(key), ack(key)),
      sent(auditor),
      ok("worker-list", workers([]), run),
    ]);
    await pass([
      ...agreeBatch(second, 4),
      ok("task-create", { task: { id: "task_plan_3", status: "ready" } }, [
        "--run",
        "run_1",
      ]),
      ok("worker-list", workers([]), run),
    ]);
    const decision = await conn.db.getDecision(second);
    const revision = (
      (await conn.db.getManifest(decision?.manifest_id ?? ""))?.references as {
        source: string;
        revision: string;
      }[]
    ).find((row) => row.source === "revision")?.revision;
    expect(await activation()).toEqual([{ revision_id: revision }]);
    expect(await conn.db.getTask(replacement)).toMatchObject({
      state: "superseded",
    });
    expect(await conn.db.getTask("task_plan_3")).toMatchObject({
      rework_of: replacement,
      state: "ready",
    });
  });

  test("a cancelled change_spec Decision leaves the Revision inactive and the Task as it was", async () => {
    await dispatchedPlan(conn);
    const id = await openChangeSpec();
    await conn.db.transaction((tx) =>
      cancelDecision(tx, { decision: id, at: new Date(), host: "local" }),
    );
    expect((await conn.db.getDecision(id))?.state).toBe("cancelled");
    expect(await activation()).toEqual([]);
    expect((await conn.db.getTask(planTask))?.state).toBe("dispatched");
    expect(await supersedeOp(id)).toBeNull();
    expect((await events(conn, "decision"))[0]?.payload).toMatchObject({
      outcome: "cancelled",
      effect: "change_spec",
      replacement_task_id: null,
    });
  });
});

describeDb("pod check spends a Decision's wall clock", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  const idle = () => [
    ok("check", empty(), run),
    ok("worker-list", workers([]), run),
  ];

  async function openedAt(): Promise<{ id: string; createdAt: Date }> {
    const id = await opened(conn, await deliveredPlan(conn));
    const decision = await conn.db.getDecision(id);
    if (decision === null) throw new Error("no Decision");
    return { id, createdAt: decision.created_at };
  }

  async function passAt(at: Date) {
    const { orca, log } = replay(conn, idle());
    const outcome = await checkPass(
      conn.db,
      orca,
      null,
      log,
      checkInput({ now: () => at }),
    );
    orca.assertDone();
    expect(outcome).toMatchObject({ ok: true });
  }

  const later = (from: Date, seconds: number) =>
    new Date(from.getTime() + seconds * 1000);

  async function decisionEvents(id: string) {
    return conn.sql<{ outcome: string; reason: string; field: string | null }[]>`
      select payload->>'outcome' as outcome, payload->>'reason' as reason,
        payload->>'budget_exhausted' as field
      from ledger.event where type = 'decision' and payload->>'decision_id' = ${id}
      order by id`;
  }

  test("a pass inside the budget persists spent.wall_clock and changes nothing else", async () => {
    const { id, createdAt } = await openedAt();
    await passAt(later(createdAt, 60));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "round:1",
      spent: { wall_clock: 60, relaunches: 0, tool_calls: 0, context_tokens: 0 },
    });
    expect(await decisionEvents(id)).toEqual([]);
  });

  test("a pass past created_at + wall_clock ends needs_human runtime-failure, once", async () => {
    const { id, createdAt } = await openedAt();
    await passAt(later(createdAt, 7201));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
      spent: { wall_clock: 7201 },
      closed_at: later(createdAt, 7201),
    });
    expect(await decisionEvents(id)).toEqual([
      { outcome: "needs_human", reason: "runtime-failure", field: "wall_clock" },
    ]);
    const [rounds] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.decision_round where decision_id = ${id}`;
    expect(rounds?.n).toBe(0);
    await passAt(later(createdAt, 9000));
    expect(await decisionEvents(id)).toHaveLength(1);
    expect((await conn.db.getDecision(id))?.spent).toMatchObject({
      wall_clock: 7201,
    });
  });

  test("a proposal that arrives after the wall clock is ignored as settled_decision and spends nothing", async () => {
    const { id, createdAt } = await openedAt();
    await passAt(later(createdAt, 7201));
    const { orca, log } = replay(conn, [
      ok("check", batch("delivery_late", [proposal("p_late", id, 1)]), run),
      ok("check", empty("delivery_late"), ack("delivery_late")),
      ok("worker-list", workers([]), run),
    ]);
    const outcome = await checkPass(
      conn.db,
      orca,
      null,
      log,
      checkInput({ now: () => later(createdAt, 9000) }),
    );
    orca.assertDone();
    expect(outcome).toMatchObject({ ok: true, result: { ignored: 1 } });
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      spent: { wall_clock: 7201 },
    });
  });

  test("pod check --wait --decision returns when the budget settles the Decision", async () => {
    const { id, createdAt } = await openedAt();
    const { orca, log } = replay(conn, idle());
    const outcome = await checkWait(conn.db, orca, null, log, {
      ...checkInput({ now: () => later(createdAt, 7201) }),
      decision: id,
      interval: 5,
      timeout: 60,
      sleep: () => Promise.reject(new Error("no sleep expected")),
    });
    orca.assertDone();
    expect(outcome).toMatchObject({ ok: true });
    expect((await conn.db.getDecision(id))?.reason).toBe("runtime-failure");
  });
});

describeDb("pod check reads a human ruling on a needs_human Decision", () => {
  let conn: Connection;
  let tracker: FakeTracker;
  let bypassPath: string;
  const relaunched = "ctx_decider_2";
  const policy = {
    gates: { hqa_after_deploy: { keeper: "human", type: "HQA" } },
    principals: { human: { tracker_account: "keeper-1" } },
  };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function start(limits: Json = {}): Promise<string> {
    const id = await opened(
      conn,
      await deliveredPlan(conn, { ...policy, limits }),
    );
    tracker = fakeTracker(
      trackerStory({ ref: { provider: "linear", external_id: "S-9" } }),
    );
    bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-ruling-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
    return id;
  }

  function say(body: string, authorId = "keeper-1") {
    tracker.comments.unshift({
      ref: {
        provider: "linear",
        external_id: "S-9",
        comment_id: `c-${tracker.comments.length + 1}`,
      },
      authorId,
      body,
      editedAt: null,
    });
  }

  async function pass(entries: TempEntry[], withTracker = true) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(
      conn.db,
      orca,
      withTracker ? tracker : null,
      log,
      checkInput({ hostName: "h1", bypassPath }),
    );
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result;
  }

  function delivery(n: number, messages: unknown[], after: TempEntry[] = []) {
    const id = `delivery_r${n}`;
    return [
      ok("check", batch(id, messages), run),
      ok("check", empty(id), ack(id)),
      ...after,
      ok("worker-list", workers([]), run),
    ];
  }

  const quiet = (n: number, after: TempEntry[] = []) => [
    ok("check", empty(`delivery_q${n}`), run),
    ...after,
    ok("worker-list", workers([]), run),
  ];

  const opensAuditor = [
    seatTask("auditor"),
    ok("worker-start", seatStarted(auditor, "m-3"), ["--task", "orca_auditor"]),
    sent(auditor),
  ];

  async function failedInRound2(): Promise<string> {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor), false);
    await pass(
      delivery(2, [audit("a1", id, 1, "disagree")], [sent(decider)]),
      false,
    );
    await conn.db.settleDispatch(decider, {
      activity: "waiting",
      settlement: "failed",
      settled_at: new Date(),
    });
    await conn.db.transaction((tx) =>
      failDecision(tx, { decision: id, at: new Date(), host: "local" }),
    );
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
      outcome: expect.objectContaining({ round: 2 }),
    });
    return id;
  }

  async function sentBodies(to: string): Promise<string[]> {
    const rows = await conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event
      where type = 'receipt' and payload->>'verb' = 'send' order by id`;
    return rows
      .map((row) => JSON.stringify(row.payload))
      .filter((text) => text.includes(`dispatch:${to}`));
  }

  test("a verified resume returns to the interrupted round with the same id and manifest, and reopens the failed Seat with the summary", async () => {
    const id = await failedInRound2();
    const before = await conn.db.getDecision(id);
    say(`decision ${id} resume`);
    await pass(
      quiet(1, [
        seatTask("decider"),
        ok("worker-start", seatStarted(relaunched), ["--task", "orca_decider"]),
        sent(relaunched),
      ]),
    );
    const after = await conn.db.getDecision(id);
    expect(after).toMatchObject({
      id,
      state: "round:2",
      manifest_id: before?.manifest_id,
      closed_at: null,
      spent: expect.objectContaining({ relaunches: 1 }),
    });
    expect(await conn.db.getDispatch(relaunched)).toMatchObject({
      decision_id: id,
      role: "decider",
      settlement: "open",
    });
    const [body] = await sentBodies(relaunched);
    expect(body).toContain("round 1: disagree; proposal: round 1 proposal");
    const decided = await events(conn, "decision");
    expect(decided.at(-1)?.payload).toMatchObject({
      decision_id: id,
      resumed_round: 2,
      ruling: { comment_id: "c-1", author: "keeper-1", verb: "resume" },
    });
    await pass(quiet(2));
    expect((await conn.db.getDecision(id))?.state).toBe("round:2");
  });

  test("a resume with the relaunch budget spent is refused with decision_budget_exhausted and leaves the Decision unchanged", async () => {
    const id = await failedInRound2();
    const before = await conn.db.getDecision(id);
    await conn.db.setDecisionSpent(id, {
      ...(before?.spent as Record<string, Json>),
      relaunches: 2,
    });
    say(`decision ${id} resume`);
    const result = await pass(quiet(1));
    expect(result.nextSteps).toContainEqual(
      expect.stringMatching(/^decision_budget_exhausted: Decision /),
    );
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
      manifest_id: before?.manifest_id,
    });
    const decided = await events(conn, "decision");
    expect(decided.at(-1)?.payload).toMatchObject({
      refused: "decision_budget_exhausted",
      outcome: "needs_human",
    });
    const again = await pass(quiet(2));
    expect(again.nextSteps).not.toContainEqual(
      expect.stringMatching(/^decision_budget_exhausted/),
    );
  });

  test("a resume after the wall clock is spent is refused with decision_budget_exhausted and launches nothing", async () => {
    const id = await failedInRound2();
    await conn.sql`update ledger.decision
      set created_at = now() - interval '3 hours' where id = ${id}`;
    say(`decision ${id} resume`);
    const result = await pass(quiet(1));
    expect(result.nextSteps).toContainEqual(
      expect.stringMatching(
        /^decision_budget_exhausted: Decision \S+ has spent its wall_clock budget/,
      ),
    );
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
      spent: expect.objectContaining({ relaunches: 0 }),
    });
  });

  test("a ruling by the worker token's author is ignored as an unverified source", async () => {
    const id = await failedInRound2();
    say(`decision ${id} resume`, "bot");
    const result = await pass(quiet(1));
    expect(result.nextSteps).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^receipt_unverified_source: Decision ${id} ruling comment c-1 by bot`,
        ),
      ),
    );
    expect((await conn.db.getDecision(id))?.state).toBe("needs_human");
  });

  test("a resume on a disagreement Decision changes nothing and says why", async () => {
    const id = await start({ decision_rounds: 1 });
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor), false);
    await pass(delivery(2, [audit("a1", id, 1, "disagree")]), false);
    say(`decision ${id} resume`);
    const result = await pass(quiet(1));
    expect(result.nextSteps).toContain(
      `Decision ${id} is needs_human: disagreement; a resume ruling applies only to runtime-failure`,
    );
    expect((await conn.db.getDecision(id))?.reason).toBe("disagreement");
  });

  test("an agreed ruling on a disagreement Decision applies accept_plan with the note", async () => {
    const id = await start({ decision_rounds: 1 });
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor), false);
    await pass(delivery(2, [audit("a1", id, 1, "disagree")]), false);
    say(`decision ${id} agreed\nship the two-release plan`);
    await pass(quiet(1));
    expect(await conn.db.getDecision(id)).toMatchObject({
      state: "agreed",
      outcome: { result: "agreed", text: "ship the two-release plan" },
    });
    expect((await conn.db.getTask(planTask))?.state).toBe("done");
    expect((await conn.db.getTask(implementTask))?.state).toBe("ready");
  });

  test("a cancelled ruling holds the Task", async () => {
    const id = await failedInRound2();
    say(`decision ${id} cancelled`);
    await pass(quiet(1));
    expect((await conn.db.getDecision(id))?.state).toBe("cancelled");
    expect((await conn.db.getTask(planTask))?.state).toBe("hold");
  });

  test("two verified rulings that disagree apply neither", async () => {
    const id = await failedInRound2();
    say(`decision ${id} cancelled`);
    say(`decision ${id} resume`);
    const result = await pass(quiet(1));
    expect(result.nextSteps).toContain(
      `Decision ${id} has conflicting rulings c-2 and c-1; post one new ruling`,
    );
    expect((await conn.db.getDecision(id))?.state).toBe("needs_human");
  });

  test("no needs_human Decision makes no tracker readback", async () => {
    const id = await start();
    await pass(delivery(1, [proposal("p1", id, 1)], opensAuditor));
    expect(tracker.calls).not.toContain("readback");
  });
});
