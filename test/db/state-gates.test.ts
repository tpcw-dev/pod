import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { makeDb } from "../../src/adapters/postgres/repository.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { StateView } from "../../src/core/domain/state.ts";
import type { Repo } from "../../src/core/ports/db.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { postVerdict } from "../../src/core/gate/verdict.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { fitBudget } from "../../src/core/state/budget.ts";
import { renderState, renderStateGates } from "../../src/core/state/render.ts";
import { runGates } from "../../src/core/state/sections.ts";
import {
  buildState,
  buildStateGates,
  stateBudget,
} from "../../src/core/state/view.ts";
import type { DocsPort } from "../../src/core/ports/docs.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { deliver, gatedRun, headSha } from "./gate-fixture.ts";
import { dbUrl, describeDb, openDb, resetDb } from "./helpers.ts";
import { deliveredPlan, opened, planTask } from "./decision-fixture.ts";
import {
  failMerge,
  keeperSays,
  mergeRun,
  newHead,
  passReworkReview,
  recordKeeper,
  settledPass,
} from "./merge-fixture.ts";
import { dispatched, replay } from "./run-fixture.ts";
import { processValue } from "./seed.ts";

const now = new Date("2026-11-17T12:00:00.000Z");
const gates = {
  review: { keeper: "rev-1", type: "AQA" },
  merge: { keeper: "human", type: "HQA" },
};
const principals = { human: { tracker_account: "keeper-1" } };

describeDb("pod state story:<id> gates", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function state(story: string | null = "S-1"): Promise<StateView> {
    const built = await buildState(
      { repo: conn.db, host: "local", docs: null, now: () => now },
      { story, project: null },
    );
    if (!built.ok) throw new Error(built.refusal.message);
    return built.view;
  }

  async function gated() {
    await gatedRun(conn, {
      gates,
      principals,
      gate: "review",
      shipGate: "merge",
    });
  }

  async function postReview() {
    const posted = await postVerdict(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      {
        file: {
          gate: "review",
          task: "task_r",
          head_sha: headSha.slice(0, 7),
          reviewer: "rev-1",
          outcome: "PASS",
        },
        generation: 1,
        host: "local",
        command: "pod verdict post verdict.yaml --generation 1",
        now: () => new Date(),
      },
    );
    if (!posted.ok) throw new Error(posted.refusal.message);
  }

  async function recordMerge() {
    await dispatched(conn, "ctx_3", { task: "task_s", seat: "dev-1" });
    await deliver(conn, "ctx_3", "task_s");
    const tracker = fakeTracker();
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: "c-1" },
      authorId: "keeper-1",
      body: "merge PASS",
      editedAt: null,
    });
    const bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-gates-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-11-17T00:00:00.000Z" })}\n`,
    );
    const recorded = await recordHqa(
      conn.db,
      noCalls(),
      tracker,
      receiptLog(conn.db, "local"),
      {
        story: { provider: "linear", external_id: "S-1" },
        generation: 1,
        host: "local",
        hostName: "h1",
        bypassPath,
        principal: "human",
        command: "pod hqa record story:S-1 --generation 1",
        now: () => new Date(),
      },
    );
    if (!recorded.ok) throw new Error(recorded.refusal.message);
  }

  function items(view: StateView) {
    const section = view.gates;
    if (section?.status !== "ok") throw new Error("gates are not listed");
    return section.items;
  }

  test("a view with no Story and a Story with no Run have gates null", async () => {
    await gated();
    expect((await state(null)).gates).toBeNull();
    expect(renderState(await state(null))).not.toContain("## Gates");
    await conn.sql`insert into ledger.story (provider, external_id, size, stage, dependencies, synced_at)
      values ('linear', 'S-2', 's', 'impl', '[]', now())`;
    const view = await state("S-2");
    expect(view.gates).toBeNull();
    expect(renderState(view)).toContain("## Gates\nnone\n");
  });

  test("before review's verdict, review waits with no receipt and merge has a pending Task", async () => {
    await gated();
    const view = await state();
    expect(view.gates).toMatchObject({
      status: "ok",
      run_id: "run_1",
      run_state: "active",
      observed_at: now.toISOString(),
      source_revision: expect.any(String),
    });
    expect(items(view)).toEqual([
      {
        gate: "review",
        step: "review",
        type: "AQA",
        keeper: "rev-1",
        task_id: "task_r",
        task_state: "delivered",
        receipt: null,
      },
      {
        gate: "merge",
        step: "ship",
        type: "HQA",
        keeper: "human",
        task_id: "task_s",
        task_state: "pending",
        receipt: null,
      },
    ]);
    const text = renderState(view);
    expect(text).toContain("## Gates\n");
    expect(text).toContain(
      "review step review AQA keeper rev-1 task task_r delivered: no receipt",
    );
    expect(text.indexOf("## Gates")).toBeGreaterThan(
      text.indexOf("## Active Runs"),
    );
  });

  test("a verdict post lists review's receipt, and an hqa record lists merge's", async () => {
    await gated();
    await postReview();
    const [review, merge] = items(await state());
    expect(review?.receipt).toEqual({
      receipt_id: expect.any(Number),
      outcome: "PASS",
      candidate_sha: headSha,
      deployed_revision: null,
      created_at: expect.any(String),
    });
    expect(merge).toMatchObject({
      task_id: "task_s",
      task_state: "ready",
      receipt: null,
    });
    await recordMerge();
    const after = items(await state());
    expect(after[1]).toMatchObject({
      task_state: "done",
      receipt: { outcome: "PASS", candidate_sha: headSha },
    });
    expect(renderState(await state())).toContain(
      `merge step ship HQA keeper human task task_s done: PASS ${headSha} deployed none at`,
    );
  });

  test("a voided receipt is not listed", async () => {
    await gated();
    await postReview();
    await conn.sql`update ledger.gate_receipt set sync_state = 'voided'`;
    expect(items(await state())[0]?.receipt).toBeNull();
  });

  test("a done Run still lists its gates and receipts", async () => {
    await gated();
    await postReview();
    await conn.sql`update ledger.run set state = 'done' where run_id = 'run_1'`;
    const view = await state();
    expect(view.runs.runs).toEqual([]);
    expect(view.gates).toMatchObject({ status: "ok", run_state: "done" });
    expect(items(view)[0]?.receipt).toMatchObject({ outcome: "PASS" });
  });

  test("a reworked step lists its newest Task", async () => {
    await gated();
    await conn.sql`insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
      select 'task_r2', run_id, step_id, lineage_id, role, deps, spec_revision_id, 'pending', 'task_r', now()
      from ledger.task where task_id = 'task_r'`;
    expect(items(await state())[0]).toMatchObject({
      task_id: "task_r2",
      task_state: "pending",
      receipt: null,
    });
  });

  test("after a merge FAIL, the merge gate reads the re-armed merge Task with no receipt", async () => {
    await mergeRun(conn);
    await failMerge(conn, fakeTracker());
    await passReworkReview(conn);
    expect(items(await state())).toEqual([
      {
        gate: "review",
        step: "review",
        type: "AQA",
        keeper: "rev-1",
        task_id: "task_r2",
        task_state: "done",
        receipt: null,
      },
      {
        gate: "merge",
        step: "merge",
        type: "HQA",
        keeper: "human",
        task_id: "task_m2",
        task_state: "ready",
        receipt: null,
      },
    ]);
  });

  test("after the keeper's PASS on the new head, the merge gate reads a PASS receipt that names the new head", async () => {
    await mergeRun(conn);
    const tracker = fakeTracker();
    await failMerge(conn, tracker);
    await passReworkReview(conn);
    keeperSays(tracker, "merge PASS");
    const recorded = await recordKeeper(
      conn,
      tracker,
      replay(conn, [settledPass("task_m2")]).orca,
    );
    expect(recorded.ok).toBe(true);
    expect(items(await state())[1]).toEqual({
      gate: "merge",
      step: "merge",
      type: "HQA",
      keeper: "human",
      task_id: "task_m2",
      task_state: "done",
      receipt: {
        receipt_id: expect.any(Number),
        outcome: "PASS",
        candidate_sha: newHead,
        deployed_revision: null,
        created_at: expect.any(String),
      },
    });
  });

  test("when two Tasks of a step are newest, the last by task_id is listed", async () => {
    await gated();
    await conn.sql`insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
      select 'task_rx', run_id, step_id, lineage_id, role, deps, spec_revision_id, 'pending', null, now()
      from ledger.task where task_id = 'task_r'`;
    expect(items(await state())[0]?.task_id).toBe("task_rx");
  });

  test("a process with no gated step lists no items, and an unreadable process says so", async () => {
    await gated();
    const tree = await conn.db.readBrief("S-1");
    const run = tree.stories[0]?.runs[0];
    const snapshot = run?.snapshot;
    const process = snapshot?.process;
    if (run === undefined || snapshot == null || process == null)
      throw new Error("no pinned process");
    const withValue = (next: Json) => ({
      ...run,
      snapshot: { ...snapshot, process: { ...process, value: next } },
    });
    const ungated: Json = {
      ...processValue,
      steps: [
        { id: "build", type: "worker", role: "developer", spec: "Build it." },
        { id: "review", type: "worker", role: "reviewer", needs: ["build"] },
      ],
    };
    const at = now.toISOString();
    expect(runGates(withValue(ungated), [], at)).toMatchObject({
      status: "ok",
      items: [],
    });
    const unreadable = runGates(withValue({ steps: [] }), [], at);
    expect(unreadable).toMatchObject({
      status: "process_unreadable",
      detail: expect.stringMatching(/\S/),
      source_revision: snapshot.process_revision_id,
    });
    expect(unreadable).not.toHaveProperty("items");
    expect(runGates({ ...run, snapshot: null }, [], at)).toMatchObject({
      status: "process_unreadable",
      detail: "no pinned process",
      source_revision: null,
    });
    const view = await state();
    const shown = renderState({
      ...view,
      gates: runGates(withValue({ steps: [] }), [], at),
    });
    expect(shown).toContain("status process_unreadable:");
    expect(
      renderState({ ...view, gates: runGates(withValue(ungated), [], at) }),
    ).toContain("no gated steps");
  });

  test("a view far over budget keeps every gate", async () => {
    await gated();
    await postReview();
    const view = await state();
    const learnings = Array.from({ length: 2000 }, (_, id) => ({
      id,
      text: "a learning long enough to cost words",
      area: "tech",
      source_story: "S-1",
      created_at: now.toISOString(),
    }));
    const fitted = fitBudget(
      { ...view, learnings: { ...view.learnings, learnings } },
      stateBudget,
    );
    expect(fitted.truncated).toBe(true);
    expect(fitted.gates).toEqual(view.gates);
    const text = renderState(fitted);
    expect(text).toContain("review step review AQA");
    expect(text).toContain("merge step ship HQA");
  });

  function gatesReadsOnly(repo: Repo): Repo {
    const allowed = new Set(["readGates", "listGateReceipts", "latestEvent"]);
    return new Proxy(repo, {
      get(target, name, receiver) {
        if (typeof name === "string" && !allowed.has(name))
          throw new Error(`the gates-only view read ${name}`);
        return Reflect.get(target, name, receiver);
      },
    });
  }

  const docsUnread = new Proxy({} as DocsPort, {
    get(_target, name) {
      throw new Error(`the gates-only view read docs ${String(name)}`);
    },
  });

  async function holdShip() {
    await conn.sql`update ledger.task set state = 'hold' where task_id = 'task_s'`;
    await conn.sql`insert into ledger.event (type, ts, host, run_id, task_id, payload, source)
      values ('hold', now(), 'local', 'run_1', 'task_s', '{"reason": "timeout"}', '{}')`;
  }

  async function longRunAndFinishedRun() {
    await conn.sql`insert into ledger.event (type, ts, host, run_id, payload, source)
      select 'tick', now(), 'local', 'run_1', jsonb_build_object('n', n), '{}'
      from generate_series(1, 300) as n`;
    await conn.sql`insert into ledger.run (run_id, story_provider, story_external_id, host, coordinator, owner_generation, snapshot_hash, state, created_at)
      select 'run_0', story_provider, story_external_id, host, coordinator, owner_generation, snapshot_hash, 'done', created_at
      from ledger.run where run_id = 'run_1'`;
    await conn.sql`insert into config.snapshot (run_id, crew_revision_id, process_revision_id, policy_revision_id, rate_revision_id, effective_gate_map, hash, pinned_at, project, profile)
      select 'run_0', crew_revision_id, process_revision_id, policy_revision_id, rate_revision_id, effective_gate_map, hash, pinned_at, project, profile
      from config.snapshot where run_id = 'run_1'`;
    await conn.sql`insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
      select task_id || '_0', 'run_0', step_id, lineage_id, role, deps, spec_revision_id, 'hold', null, created_at
      from ledger.task where run_id = 'run_1'`;
    await conn.sql`insert into ledger.event (type, ts, host, run_id, payload, source)
      select 'tick', now(), 'local', 'run_0', jsonb_build_object('n', n), '{}'
      from generate_series(1, 50) as n`;
  }

  async function gatesStatements(
    story: string,
  ): Promise<{ view: unknown; statements: string[] }> {
    const statements: string[] = [];
    const sql = postgres(dbUrl(), {
      onnotice: () => {},
      debug: (_connection, query) => statements.push(query),
    });
    try {
      const built = await buildStateGates(
        {
          repo: gatesReadsOnly(makeDb(drizzle(sql))),
          host: "local",
          docs: docsUnread,
          now: () => now,
        },
        { story, project: null },
      );
      if (!built.ok) throw new Error(built.refusal.message);
      return { view: built.view, statements };
    } finally {
      await sql.end();
    }
  }

  const eventReads = (statements: readonly string[]) =>
    statements.filter((query) => /from "ledger"\."event"/.test(query));

  test("on a long current Run beside a finished Run, the gates-only view equals the full view's runs and gates", async () => {
    await gated();
    await postReview();
    await holdShip();
    await longRunAndFinishedRun();
    const full = await state();
    const { view } = await gatesStatements("S-1");
    expect(view).toEqual({
      scope: { story: "S-1", project: null },
      runs: full.runs,
      gates: full.gates,
    });
    expect(full.runs.runs.map((row) => row.run_id)).toEqual(["run_1"]);
    expect(full.runs.runs[0]?.waiting_on).toContain("task_s hold timeout");
    expect(items(full)[0]?.receipt).toMatchObject({ outcome: "PASS" });
    await conn.sql`update ledger.run set state = 'done' where run_id = 'run_1'`;
    const done = await state();
    expect((await gatesStatements("S-1")).view).toEqual({
      scope: { story: "S-1", project: null },
      runs: done.runs,
      gates: done.gates,
    });
    expect(done.gates).toMatchObject({ run_id: "run_1", run_state: "done" });
  });

  test("the gates-only view names an open decision and drops a closed one, as the full view does", async () => {
    const id = await opened(conn, await deliveredPlan(conn));
    const full = async () => {
      const built = await buildState(
        { repo: conn.db, host: "local", docs: null, now: () => now },
        { story: "S-9", project: null },
      );
      if (!built.ok) throw new Error(built.refusal.message);
      return {
        scope: built.view.scope,
        runs: built.view.runs,
        gates: built.view.gates,
      };
    };
    const open = await full();
    expect(open.runs.runs[0]?.waiting_on).toContain(
      `${planTask} decision ${id} round 1`,
    );
    expect((await gatesStatements("S-9")).view).toEqual(open);
    await conn.db.updateDecisionState(id, {
      from: "round:1",
      to: { kind: "needs_human", reason: "disagreement" },
      outcome: { result: "needs_human", text: "needs_human: disagreement" },
      closed_at: new Date(),
    });
    const closed = await full();
    expect(closed.runs.runs[0]?.waiting_on).toContain(
      `${planTask} decision plan`,
    );
    expect((await gatesStatements("S-9")).view).toEqual(closed);
  });

  test("the gates-only read sends no event list select, only the held Task's one-row hold read", async () => {
    await gated();
    await postReview();
    await longRunAndFinishedRun();
    const quiet = await gatesStatements("S-1");
    expect(quiet.statements.length).toBeGreaterThan(0);
    expect(eventReads(quiet.statements)).toEqual([]);
    await holdShip();
    const held = await gatesStatements("S-1");
    const reads = eventReads(held.statements);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/"task_id" = \$\d+/);
    expect(reads[0]).toMatch(/limit \$\d+$/);
    for (const query of held.statements)
      expect(query).not.toMatch(
        /from "ledger"\."(dispatch|operation|evidence_manifest)"/,
      );
  });

  test("the gates-only view equals the full view's gates and runs and makes no other read", async () => {
    await gated();
    await postReview();
    await recordMerge();
    const full = await state();
    const built = await buildStateGates(
      {
        repo: gatesReadsOnly(conn.db),
        host: "local",
        docs: docsUnread,
        now: () => now,
      },
      { story: "S-1", project: null },
    );
    if (!built.ok) throw new Error(built.refusal.message);
    expect(built.view).toEqual({
      scope: { story: "S-1", project: null },
      runs: full.runs,
      gates: full.gates,
    });
    expect(items(full)[1]?.receipt).toMatchObject({ outcome: "PASS" });
  });

  test("the gates-only view refuses an unknown Story and renders only Active Runs and Gates", async () => {
    await gated();
    const ctx = { repo: conn.db, host: "local", docs: null, now: () => now };
    const missing = await buildStateGates(ctx, {
      story: "S-404",
      project: null,
    });
    expect(missing).toMatchObject({
      ok: false,
      refusal: { code: "story_not_found" },
    });
    const built = await buildStateGates(ctx, { story: "S-1", project: null });
    if (!built.ok) throw new Error(built.refusal.message);
    const text = renderStateGates(built.view);
    expect(text.match(/^## .*$/gm)).toEqual(["## Active Runs", "## Gates"]);
    expect(text).toContain(
      "review step review AQA keeper rev-1 task task_r delivered: no receipt",
    );
    const full = renderState(await state());
    for (const line of text.split("\n")) expect(full).toContain(line);
  });
});
