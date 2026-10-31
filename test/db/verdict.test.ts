import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { contentHash } from "../../src/core/gate/receipt.ts";
import { postVerdict, type VerdictFile } from "../../src/core/gate/verdict.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { gatedRun, headSha } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { taskState } from "./run-fixture.ts";

const aqa = { pr: { keeper: "rev-1", type: "AQA" } };

function file(over: Partial<VerdictFile> = {}): VerdictFile {
  return {
    gate: "pr",
    task: "task_r",
    head_sha: headSha.slice(0, 7),
    reviewer: "rev-1",
    outcome: "PASS",
    ...over,
  };
}

describeDb("pod verdict post", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function post(over: Partial<VerdictFile> = {}, generation = 1) {
    return postVerdict(conn.db, noCalls(), receiptLog(conn.db, "local"), {
      file: file(over),
      generation,
      host: "local",
      command: "pod verdict post verdict.yaml --generation 1",
      now: () => new Date(),
    });
  }

  async function receipts() {
    return conn.sql<
      { id: number; sync_state: string; source: Record<string, unknown> }[]
    >`select id, sync_state, source from ledger.gate_receipt order by id`;
  }

  async function outbox() {
    return conn.sql<
      { op_key: string; payload: { body: string } }[]
    >`select op_key, payload from ledger.outbox order by id`;
  }

  test("a 7-char prefix of the candidate passes the gate and readies the dependent", async () => {
    await gatedRun(conn, { gates: aqa });
    const posted = await post({ notes: "Looks right." });
    expect(posted).toMatchObject({
      ok: true,
      result: {
        task_id: "task_r",
        outcome: "PASS",
        state: "done",
        promoted: ["task_s"],
        candidate_sha: headSha,
        replayed: false,
      },
    });
    expect(await taskState(conn, "task_r")).toBe("done");
    expect(await taskState(conn, "task_s")).toBe("ready");
    const [receipt] = await receipts();
    const [row] = await outbox();
    expect(row?.payload.body).toBe(
      `rev-1: pr PASS\nHead: ${headSha.slice(0, 7)}\n\nLooks right.`,
    );
    expect(receipt).toMatchObject({
      sync_state: "pending",
      source: {
        kind: "verdict_file",
        reviewer: "rev-1",
        content_hash: contentHash(row?.payload.body ?? ""),
        op_key: row?.op_key,
      },
    });
  });

  test("the same file twice returns the recorded result with one receipt and one outbox row", async () => {
    await gatedRun(conn, { gates: aqa });
    const first = await post();
    const second = await post();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result).toMatchObject({
      receipt_id: first.result.receipt_id,
      op_key: first.result.op_key,
      state: "done",
      replayed: true,
    });
    expect(await receipts()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    expect(await post({ outcome: "FAIL" })).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
  });

  test("a stale SHA is receipt_stale_sha naming the candidate", async () => {
    await gatedRun(conn, { gates: aqa });
    const posted = await post({ head_sha: "fedcba9" });
    expect(posted).toMatchObject({
      ok: false,
      refusal: {
        code: "receipt_stale_sha",
        message: expect.stringContaining(headSha),
        nextSteps: [`request a new review of the candidate SHA ${headSha}`],
      },
    });
    expect(await receipts()).toHaveLength(0);
    expect(await taskState(conn, "task_r")).toBe("delivered");
  });

  test("the developer's seat as reviewer is reviewer_not_independent", async () => {
    await gatedRun(conn, { gates: aqa, builder: "both-1" });
    const posted = await post({ reviewer: "both-1" });
    expect(posted).toMatchObject({
      ok: false,
      refusal: {
        code: "reviewer_not_independent",
        message: expect.stringMatching(/both-1.*Dispatch ctx_1/),
      },
    });
    expect(await receipts()).toHaveLength(0);
  });

  test("a seat whose Dispatch of a needed Task settled failed is not independent", async () => {
    await gatedRun(conn, { gates: aqa, builder: "both-1" });
    await conn.sql`update ledger.dispatch set settlement = 'failed' where dispatch_id = 'ctx_1'`;
    expect(await post({ reviewer: "both-1" })).toMatchObject({
      ok: false,
      refusal: { code: "reviewer_not_independent" },
    });
  });

  test("an HQA gate, a bare string gate, and a stale generation are refused before any write", async () => {
    await gatedRun(conn, { gates: { pr: { keeper: "human", type: "HQA" } } });
    expect(await post()).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", message: "gate pr is HQA" },
    });
    await gatedRun(conn, { gates: ["pr"] });
    expect(await post()).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message: "gate pr has no keeper and type in the Run's policy",
      },
    });
    await gatedRun(conn, { gates: aqa });
    expect(await post({}, 2)).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(await receipts()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  test("a FAIL takes the review's FAIL edge", async () => {
    await gatedRun(conn, { gates: aqa });
    expect(await post({ outcome: "FAIL" })).toMatchObject({
      ok: true,
      result: { outcome: "FAIL", state: "hold" },
    });
    expect(await taskState(conn, "task_s")).toBe("pending");
  });

  test("a reviewer outside the step's role is role_unfilled", async () => {
    await gatedRun(conn, { gates: aqa });
    expect(await post({ reviewer: "dev-1" })).toMatchObject({
      ok: false,
      refusal: { code: "role_unfilled" },
    });
  });
});
