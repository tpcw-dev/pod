import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { StateView } from "../../src/core/domain/state.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { postVerdict } from "../../src/core/gate/verdict.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { fitBudget } from "../../src/core/state/budget.ts";
import { renderState } from "../../src/core/state/render.ts";
import { runGates } from "../../src/core/state/sections.ts";
import { buildState, stateBudget } from "../../src/core/state/view.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { deliver, gatedRun, headSha } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { dispatched } from "./run-fixture.ts";
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
});
