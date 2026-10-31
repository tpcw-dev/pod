import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { HqaAmbiguous, recordHqa } from "../../src/core/gate/hqa.ts";
import { contentHash } from "../../src/core/gate/receipt.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { deliveredPlan } from "./decision-fixture.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { gatedRun, headSha, type GatedRun } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { events, taskState } from "./run-fixture.ts";

const principals = {
  human: { tracker_account: "keeper-1" },
  relay: { tracker_account: "relay-1" },
};
const hqa = { keeper: "human", type: "HQA" };
const deploy = {
  environment: "staging",
  deployment_id: "dep-1",
  deployed_revision: "rev-9",
  source_commit: headSha,
};

describeDb("pod hqa record", () => {
  let conn: Connection;
  let tracker: FakeTracker;
  let bypassPath: string;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function setup(over: Partial<GatedRun> = {}, bypass = "pass") {
    await gatedRun(conn, { gates: { pr: hqa }, principals, ...over });
    tracker = fakeTracker();
    bypassPath = join(mkdtempSync(join(tmpdir(), "pod-hqa-")), "bypass.jsonl");
    if (bypass !== "")
      writeFileSync(
        bypassPath,
        `${JSON.stringify({ host: "h1", result: bypass, at: "2026-10-31T00:00:00.000Z" })}\n`,
      );
  }

  function say(body: string, authorId = "keeper-1") {
    tracker.comments.unshift({
      ref: {
        provider: "linear",
        external_id: "S-1",
        comment_id: `c-${tracker.comments.length + 1}`,
      },
      authorId,
      body,
      editedAt: null,
    });
  }

  function record() {
    return recordHqa(
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
    );
  }

  async function bypassEvents() {
    return (await events(conn, "receipt"))
      .map((row) => row.payload)
      .filter((payload) => payload["check"] === "bypass");
  }

  async function receipts() {
    return conn.sql<
      {
        sync_state: string;
        keeper: string;
        deployed_revision: string | null;
        source: Record<string, unknown>;
      }[]
    >`select sync_state, keeper, deployed_revision, source from ledger.gate_receipt order by id`;
  }

  test("a worker's comment is refused and the Task stays delivered", async () => {
    await setup();
    say("pr PASS", "worker-1");
    expect(await record()).toMatchObject({
      ok: false,
      refusal: {
        code: "receipt_unverified_source",
        message: expect.stringContaining("worker-1"),
      },
    });
    expect(await receipts()).toEqual([]);
    expect(await taskState(conn, "task_r")).toBe("delivered");
  });

  test("a ready human_wait gate accepts the keeper comment", async () => {
    await setup({ review: "human_wait" });
    expect(await taskState(conn, "task_r")).toBe("ready");
    say("pr PASS");
    expect(await record()).toMatchObject({
      ok: true,
      result: { gate: "pr", outcome: { state: "done" } },
    });
    expect(await taskState(conn, "task_r")).toBe("done");
  });

  test("the keeper's comment is accepted, synced, and passes the gate", async () => {
    await setup();
    say("jerry: pr PASS");
    const recorded = await record();
    expect(recorded).toMatchObject({
      ok: true,
      result: {
        gate: "pr",
        outcome: { state: "done", promoted: ["task_s"] },
      },
    });
    expect(await receipts()).toMatchObject([
      {
        sync_state: "synced",
        keeper: "human",
        source: {
          kind: "tracker_comment",
          comment_id: "c-1",
          author_id: "keeper-1",
          relayed_by: null,
          content_hash: contentHash("jerry: pr PASS"),
          readback_at: expect.any(String),
        },
      },
    ]);
    expect(tracker.calls).toEqual(["readback", "readComment"]);
  });

  test("the relay's comment with a trailer is accepted and records relayed_by", async () => {
    await setup();
    say("pr PASS\nrelayed-by: session-7", "relay-1");
    expect((await record()).ok).toBe(true);
    expect(await receipts()).toMatchObject([
      {
        source: {
          author_id: "relay-1",
          relayed_by: "session-7",
          content_hash: contentHash("pr PASS"),
        },
      },
    ]);
  });

  test("a missing bypass result refuses with the remedy, and a first sight of a result records it once", async () => {
    await setup({}, "");
    say("pr PASS");
    expect(await record()).toMatchObject({
      ok: false,
      refusal: {
        code: "receipt_unverified_source",
        nextSteps: [
          expect.stringContaining("separate OS user or a separate host"),
        ],
      },
    });
    expect(await bypassEvents()).toEqual([]);
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "fail", at: "t-1" })}\n`,
    );
    expect(await record()).toMatchObject({
      ok: false,
      refusal: { code: "receipt_unverified_source" },
    });
    expect(await record()).toMatchObject({ ok: false });
    expect(await bypassEvents()).toEqual([
      { check: "bypass", host: "h1", at: "t-1", result: "fail" },
    ]);
  });

  test("no verdict comment leaves the gate waiting with exit 0", async () => {
    await setup();
    say("looks good to me");
    expect(await record()).toMatchObject({
      ok: true,
      result: {
        receipt_id: null,
        nextSteps: [
          'gate pr waits for a comment whose first line is "pr PASS" or "pr FAIL"',
        ],
      },
    });
  });

  test("hqa_after_deploy without a deploy event is receipt_no_deploy", async () => {
    await setup({ gates: { hqa_after_deploy: hqa }, gate: "hqa_after_deploy" });
    say("hqa_after_deploy PASS");
    expect(await record()).toMatchObject({
      ok: false,
      refusal: {
        code: "receipt_no_deploy",
        nextSteps: [
          "record a worker_done payload deploy with environment, deployment_id, deployed_revision, source_commit",
        ],
      },
    });
    expect(await receipts()).toEqual([]);
  });

  test("hqa_after_deploy binds the deployed revision and refuses a stale Deployed line", async () => {
    const after = {
      gates: { hqa_after_deploy: hqa },
      gate: "hqa_after_deploy",
      reviewFields: { deploy },
    };
    await setup(after);
    say("hqa_after_deploy PASS\nDeployed: rev-8");
    expect(await record()).toMatchObject({
      ok: false,
      refusal: { code: "receipt_stale_sha" },
    });
    await setup(after);
    say("hqa_after_deploy PASS\nDeployed: rev-9");
    expect((await record()).ok).toBe(true);
    expect(await receipts()).toMatchObject([{ deployed_revision: "rev-9" }]);
  });

  test("an AQA gate is not waited on, and two waiting HQA Tasks are ambiguous", async () => {
    await setup({ gates: { pr: { keeper: "rev-1", type: "AQA" } } });
    say("pr PASS");
    expect(await record()).toMatchObject({
      ok: true,
      result: { nextSteps: ["no delivered Task waits on an HQA gate"] },
    });
    await setup({ shipGate: "pr" });
    await conn.sql`update ledger.task set state = 'delivered' where task_id = 'task_s'`;
    await expect(record()).rejects.toBeInstanceOf(HqaAmbiguous);
  });
});

describeDb("pod hqa record on a decision step", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("a Story whose waiting Task is a decision step is decision_not_gate", async () => {
    await deliveredPlan(conn, { gates: [], principals });
    const bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-hqa-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
    const outcome = await recordHqa(
      conn.db,
      noCalls(),
      fakeTracker(),
      receiptLog(conn.db, "local"),
      {
        story: { provider: "linear", external_id: "S-9" },
        generation: 1,
        host: "local",
        hostName: "h1",
        bypassPath,
        command: "pod hqa record story:S-9 --generation 1",
        now: () => new Date(),
      },
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "decision_not_gate",
        nextSteps: [expect.stringMatching(/^pod decide --task task_plan /)],
      },
    });
  });
});
