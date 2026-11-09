import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { recordDeploy } from "../../src/core/deploy/record.ts";
import type { Deploy } from "../../src/core/domain/delivery.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { noCalls, ok } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { deliver, headSha } from "./gate-fixture.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { dispatched, events, replay, taskState } from "./run-fixture.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

const squashSha = "fedcba9876543210fedcba9876543210fedcba98";
const otherSha = "1111111111111111111111111111111111111111";
const trees: Record<string, string> = {
  [headSha]: "tree-1",
  [squashSha]: "tree-1",
  [otherSha]: "tree-2",
};

const hold = ["timeout", "cancel", "unknown"];
const deployProcess = {
  ...processValue,
  steps: [
    { id: "build", type: "worker", role: "developer", spec: "Build it." },
    {
      id: "deploy",
      type: "external_action",
      needs: ["build"],
      adapter: "deploy",
      event_fields: [
        "environment",
        "deployment_id",
        "deployed_revision",
        "source_commit",
      ],
    },
    {
      id: "hqa",
      type: "human_wait",
      needs: ["deploy"],
      gate: "hqa_after_deploy",
      binds: "deployed_revision",
    },
  ],
  edges: [
    { from: "build", on: "done", to: "deploy" },
    { from: "build", on: hold, to: "hold" },
    { from: "deploy", on: "done", to: "hqa" },
    { from: "deploy", on: ["unknown", "cancel"], to: "hold" },
    { from: "hqa", on: "PASS", to: "done" },
    { from: "hqa", on: ["FAIL", "cancel"], to: "hold" },
  ],
};

function line(revision: string, over: Partial<Deploy> = {}): Deploy {
  return {
    environment: "local",
    deployment_id: "v0.1.1",
    deployed_revision: revision,
    source_commit: revision,
    ...over,
  };
}

describeDb("pod deploy record", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    await activeRevision(conn.db, "policy", "default", {
      gates: { hqa_after_deploy: { keeper: "human", type: "HQA" } },
      principals: { human: { tracker_account: "keeper-1" } },
    });
    await activeRevision(conn.db, "crew", "default", crewValue);
    await activeRevision(conn.db, "process", "impl", deployProcess);
    const { orca, log } = replay(conn, [
      ok("run-create", { run: { id: "run_1" } }),
      ok("task-create", { task: { id: "task_b", status: "ready" } }),
      ok("task-create", { task: { id: "task_d", status: "pending" } }),
      ok("task-create", { task: { id: "task_h", status: "pending" } }),
    ]);
    const created = await runCreate(conn.db, orca, null, log, {
      story: "S-1",
      process: { name: "impl", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "session-1",
      host: "local",
      provider: "linear",
      command: "pod run create story:S-1",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    await dispatched(conn, "ctx_1", { seat: "dev-1" });
    await deliver(conn, "ctx_1", "task_b", { head: headSha });
  });

  function record(deploy: Deploy, generation = 1) {
    return recordDeploy(conn.db, {
      story: { provider: "linear", external_id: "S-1" },
      generation,
      line: deploy,
      host: "local",
      treeOf: (sha) => Promise.resolve(trees[sha] ?? null),
      now: () => new Date(),
    });
  }

  test("the deploy Task waits ready after the build", async () => {
    expect(await taskState(conn, "task_d")).toBe("ready");
    expect(await taskState(conn, "task_h")).toBe("pending");
  });

  test("a deploy line delivers the Task and pod hqa record binds its revision", async () => {
    expect(await record(line(headSha))).toMatchObject({
      ok: true,
      result: {
        run_id: "run_1",
        task_id: "task_d",
        state: "done",
        deployed_revision: headSha,
        replayed: false,
      },
    });
    expect(await taskState(conn, "task_d")).toBe("done");
    expect(await taskState(conn, "task_h")).toBe("ready");
    expect((await events(conn, "deploy")).map((row) => row.payload)).toEqual([
      { task_id: "task_d", ...line(headSha) },
    ]);

    const tracker = fakeTracker();
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: "c-1" },
      authorId: "keeper-1",
      body: "hqa_after_deploy PASS",
      editedAt: null,
    });
    const bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-deploy-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-11-09T00:00:00.000Z" })}\n`,
    );
    expect(
      await recordHqa(
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
          command: "pod hqa record story:S-1 --generation 1",
          now: () => new Date(),
        },
      ),
    ).toMatchObject({
      ok: true,
      result: { gate: "hqa_after_deploy", outcome: { state: "done" } },
    });
    expect(
      await conn.sql`select deployed_revision from ledger.gate_receipt`,
    ).toEqual([{ deployed_revision: headSha }]);
  });

  test("a squash revision with the candidate's tree is accepted", async () => {
    expect(await record(line(squashSha))).toMatchObject({
      ok: true,
      result: { task_id: "task_d", state: "done" },
    });
    expect(await taskState(conn, "task_h")).toBe("ready");
  });

  test.each([
    ["another tree", line(otherSha)],
    ["an unknown revision", line("2222222222222222222222222222222222222222")],
    [
      "a source commit that differs",
      line(headSha, { source_commit: squashSha }),
    ],
  ])(
    "%s refuses deploy_revision_mismatch and writes nothing",
    async (_, deploy) => {
      expect(await record(deploy)).toMatchObject({
        ok: false,
        refusal: {
          code: "deploy_revision_mismatch",
          message: expect.stringContaining(headSha),
        },
      });
      expect(await taskState(conn, "task_d")).toBe("ready");
      expect(await events(conn, "deploy")).toEqual([]);
    },
  );

  test("a replay is idempotent and a different line is not waiting", async () => {
    await record(line(headSha));
    expect(await record(line(headSha))).toMatchObject({
      ok: true,
      result: { task_id: "task_d", state: "done", replayed: true },
    });
    expect(await events(conn, "deploy")).toHaveLength(1);
    expect(await record(line(squashSha))).toMatchObject({
      ok: false,
      refusal: { code: "deploy_not_waiting" },
    });
    expect(await events(conn, "deploy")).toHaveLength(1);
  });

  test("a stale --generation is fenced", async () => {
    expect(await record(line(headSha), 2)).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(await taskState(conn, "task_d")).toBe("ready");
    expect(await events(conn, "deploy")).toEqual([]);
  });

  test("an unknown story refuses story_not_found", async () => {
    expect(
      await recordDeploy(conn.db, {
        story: { provider: "linear", external_id: "S-9" },
        generation: 1,
        line: line(headSha),
        host: "local",
        treeOf: () => Promise.resolve(null),
        now: () => new Date(),
      }),
    ).toMatchObject({ ok: false, refusal: { code: "story_not_found" } });
  });
});
