import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import { fixtures, noCalls, ok, unknownReply } from "../orca/temp-fixtures.ts";
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

  function questionFile(body: object): string {
    const dir = mkdtempSync(join(tmpdir(), "pod-question-"));
    const path = join(dir, "question.yaml");
    writeFileSync(path, stringify(body));
    return path;
  }

  function decideCli(
    effect: string,
    file: string,
    task = implementTask,
    env: Record<string, string> = {},
  ) {
    return runCli(
      [
        "decide",
        "--task",
        task,
        "--category",
        "architecture_choice",
        "--effect",
        effect,
        file,
        "--generation",
        "1",
      ],
      env,
    );
  }

  const question = {
    question: "Replace the build spec?",
    options: ["replace it", "keep it"],
  };
  const taskSpec = {
    kind: "task",
    schema_version: 1,
    spec: "Build it with the agreed error envelope.",
  };

  async function activations() {
    return conn.sql<{ revision_id: string }[]>`
      select revision_id from config.activation
      where kind = 'task' and name = ${"run_1:implement"}`;
  }

  test("a change_spec FILE with no spec is a usage error naming spec", () => {
    const result = decideCli("change_spec", questionFile(question));
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("usage");
    expect(result.json.error?.nextSteps).toEqual(["spec"]);
    expect(result.json.error?.message).toContain("no spec");
  });

  test("an accept_plan FILE with a spec is a usage error naming spec", () => {
    const result = decideCli(
      "accept_plan",
      questionFile({ ...question, spec: taskSpec }),
      planTask,
    );
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("usage");
    expect(result.json.error?.nextSteps).toEqual(["spec"]);
  });

  test("a spec that fails the Task spec schema is schema_invalid at its path", () => {
    const result = decideCli(
      "change_spec",
      questionFile({ ...question, spec: { ...taskSpec, kind: "crew" } }),
    );
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(JSON.stringify(result.json.error?.nextSteps)).toContain("spec.kind");
  });

  test("an unknown effect is a usage error naming both effects", () => {
    const result = decideCli("rewrite", questionFile(question));
    expect(result.status).toBe(2);
    expect(result.json.error?.message).toContain("accept_plan or change_spec");
  });

  test("a change_spec open on a ready worker Task inserts the Task spec Revision inactive and pins it in the manifest", async () => {
    await conn.db.setTaskState(implementTask, "ready");
    const result = decideCli(
      "change_spec",
      questionFile({ ...question, spec: taskSpec }),
      implementTask,
      {
        POD_ORCA_FIXTURES: fixtures([
          seatTask("decider"),
          ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
          sent(decider),
        ]),
      },
    );
    expect(result.status).toBe(0);
    const revisions = await conn.sql<
      { id: string; scope: string; scope_ref: string; value: unknown }[]
    >`select id, scope, scope_ref, value from config.revision
      where kind = 'task' and name = ${"run_1:implement"}`;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      scope: "run",
      scope_ref: "run_1",
      value: { spec: taskSpec.spec },
    });
    expect(await activations()).toEqual([]);
    const decision = await conn.db.getDecision(
      result.json.result?.["decision_id"] as string,
    );
    expect(decision).toMatchObject({
      effect: "change_spec",
      task_id: implementTask,
      state: "round:1",
    });
    const manifest = await conn.db.getManifest(decision?.manifest_id ?? "");
    const references = manifest?.references as {
      source: string;
      revision: string;
    }[];
    expect(references.map((row) => row.source)).toEqual([
      "story",
      "run",
      "task",
      "crew",
      "process",
      "policy",
      "revision",
    ]);
    expect(references.at(-1)?.revision).toBe(revisions[0]?.id);
  });

  test.each(["done", "superseded", "passed"] as const)(
    "change_spec on a %s Task is task_not_ready",
    async (state) => {
      await conn.db.setTaskState(implementTask, state);
      const outcome = await decide([], {
        task: implementTask,
        effect: "change_spec",
        spec: null,
      });
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "task_not_ready" },
      });
      if (!outcome.ok) expect(outcome.refusal.message).toContain(`is ${state}`);
    },
  );

  test("change_spec on the delivered plan Task opens without needing a decision step", async () => {
    const outcome = await decide(
      [
        seatTask("decider"),
        ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
        sent(decider),
      ],
      { effect: "change_spec", spec: null },
    );
    expect(outcome).toMatchObject({ ok: true, result: { state: "round:1" } });
  });
});

describeDb("pod decide runs the Reserved check before any Seat", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function rows(id: string) {
    const events = await conn.sql<
      { outcome: string; reason: string; verb: string; member: string }[]
    >`select payload->>'outcome' as outcome, payload->>'reason' as reason,
        source->>'verb' as verb, payload->'reserved'->>'member' as member
      from ledger.event where type = 'decision' and payload->>'decision_id' = ${id}
      order by id`;
    const [seats] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.dispatch where decision_id is not null`;
    const [rounds] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.decision_round`;
    const [op] = await conn.sql<{ status: string }[]>`
      select status from ledger.operation where intent = 'decide'`;
    return {
      decision: await conn.db.getDecision(id),
      events,
      seats: seats?.n,
      rounds: rounds?.n,
      op: op?.status,
    };
  }

  function quiet(over: Parameters<typeof decideInput>[1]) {
    return async (templates: Revision) => {
      const { log } = replay(conn, []);
      return openDecision(conn.db, noCalls(), log, decideInput(templates, over));
    };
  }

  test("a tradeoff question that names a purchase ends needs_human policy-required with no Seat", async () => {
    const templates = await deliveredPlan(conn);
    const outcome = await quiet({
      category: "tradeoff",
      question: "Should the plan purchase a hosted build cache?",
    })(templates);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "needs_human",
        decider_dispatch_id: "",
        round: 0,
        reserved: { class: "needs_human", member: "spend" },
      },
    });
    if (!outcome.ok) throw new Error("expected ok");
    const found = await rows(outcome.result.decision_id);
    expect(found.decision).toMatchObject({
      state: "needs_human",
      reason: "policy-required",
      closed_at: expect.any(Date),
    });
    expect(found.events).toEqual([
      { outcome: "reserved_needs_human", reason: "reserved_needs_human", verb: "decide", member: "spend" },
      { outcome: "needs_human", reason: "policy-required", verb: "decide", member: "spend" },
    ]);
    expect([found.seats, found.rounds, found.op]).toEqual([0, 0, "done"]);
    expect(await quiet({ category: "tradeoff", question: "Should the plan purchase a hosted build cache?" })(templates)).toMatchObject({
      ok: true,
      result: { decision_id: outcome.result.decision_id, state: "needs_human" },
    });
  });

  test("a deny member ends reserved_denied and returns decision_denied", async () => {
    const templates = await deliveredPlan(conn);
    const ask = quiet({ question: "Should the worker start live trading on the account?" });
    const outcome = await ask(templates);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "decision_denied" },
    });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal.message).toContain("live_trading");
    const [row] = await conn.sql<{ id: string }[]>`select id from ledger.decision`;
    const found = await rows(row?.id ?? "");
    expect(found.decision).toMatchObject({
      state: "reserved_denied",
      reason: "denied",
      closed_at: expect.any(Date),
    });
    expect(found.events).toEqual([
      { outcome: "reserved_denied", reason: "denied", verb: "decide", member: "live_trading" },
    ]);
    expect([found.seats, found.rounds, found.op]).toEqual([0, 0, "refused"]);
    expect(await ask(templates)).toMatchObject({
      ok: false,
      refusal: { code: "decision_denied" },
    });
  });

  const repoQuestion = "Should the plan create a repository for the docs site?";

  test("an authorized repo_create reaches round 1 and opens the decider", async () => {
    const templates = await deliveredPlan(conn, {
      gates: [],
      authorizations: { "S-9": { authorizes: ["repo_create"] } },
    });
    const { orca, log } = replay(conn, [
      seatTask("decider"),
      ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
      sent(decider),
    ]);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates, { question: repoQuestion }),
    );
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { state: "round:1", decider_dispatch_id: decider, reserved: null },
    });
  });

  test.each([
    ["no authorizations", { gates: [] }, repoQuestion, "repo_create"],
    [
      "another Story's entry",
      { gates: [], authorizations: { "S-1": { authorizes: ["repo_create"] } } },
      repoQuestion,
      "repo_create",
    ],
    [
      "vps_ssh without the infrastructure kind",
      { gates: [], authorizations: { "S-9": { authorizes: ["vps_ssh"] } } },
      "Should the worker ssh into the build host?",
      "vps_ssh",
    ],
  ])("an unauthorized hit with %s ends needs_human with two events", async (_, policy, question, member) => {
    const templates = await deliveredPlan(conn, policy);
    const outcome = await quiet({ question })(templates);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "needs_human",
        reserved: { class: "needs_existing_authorization", member },
      },
    });
    if (!outcome.ok) throw new Error("expected ok");
    const found = await rows(outcome.result.decision_id);
    expect(found.decision).toMatchObject({ reason: "policy-required" });
    expect(found.events.map((row) => row.outcome)).toEqual([
      "reserved_needs_human",
      "needs_human",
    ]);
    expect(found.seats).toBe(0);
  });

  const twoMembers =
    "Create a repository for the docs and ssh into the vps to deploy it";

  test("two needs_existing_authorization members with only the first authorized end needs_human naming the second", async () => {
    const templates = await deliveredPlan(conn, {
      gates: [],
      authorizations: { "S-9": { authorizes: ["repo_create"] } },
    });
    const outcome = await quiet({ question: twoMembers })(templates);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "needs_human",
        reserved: { class: "needs_existing_authorization", member: "vps_ssh" },
      },
    });
    if (!outcome.ok) throw new Error("expected ok");
    const found = await rows(outcome.result.decision_id);
    expect(found.decision).toMatchObject({ reason: "policy-required" });
    expect(found.events.map((row) => [row.outcome, row.member])).toEqual([
      ["reserved_needs_human", "vps_ssh"],
      ["needs_human", "vps_ssh"],
    ]);
    expect(found.seats).toBe(0);
  });

  test("two needs_existing_authorization members both authorized reach round 1", async () => {
    const templates = await deliveredPlan(conn, {
      gates: [],
      authorizations: {
        "S-9": {
          authorizes: ["repo_create", "vps_ssh"],
          story_kind: "infrastructure",
        },
      },
    });
    const { orca, log } = replay(conn, [
      seatTask("decider"),
      ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
      sent(decider),
    ]);
    const outcome = await openDecision(
      conn.db,
      orca,
      log,
      decideInput(templates, { question: twoMembers }),
    );
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { state: "round:1", decider_dispatch_id: decider },
    });
  });

  test("a needs_human row does not block a later request on the same Task", async () => {
    const templates = await deliveredPlan(conn);
    const first = await quiet({ category: "tradeoff", question: "Buy a build cache?" })(templates);
    expect(first).toMatchObject({ ok: true, result: { state: "needs_human" } });
    const id = await opened(conn, templates);
    expect(await conn.db.getDecision(id)).toMatchObject({ state: "round:1" });
  });
});
