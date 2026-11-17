import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { gatedRun } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { operator } from "./identity-fixture.ts";
import { taskState } from "./run-fixture.ts";

const principals = {
  [operator]: { tracker_account: "keeper-1" },
  other: { tracker_account: "other-1" },
};

describeDb("pod hqa record resolves its caller", () => {
  let conn: Connection;
  let tracker: FakeTracker;
  let bypassPath: string;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function setup(keeper: string) {
    await gatedRun(conn, {
      gates: { pr: { keeper, type: "HQA" } },
      principals,
    });
    tracker = fakeTracker();
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: "c-1" },
      authorId: "keeper-1",
      body: "pr PASS",
      editedAt: null,
    });
    bypassPath = join(
      mkdtempSync(join(tmpdir(), "pod-hqa-id-")),
      "bypass.jsonl",
    );
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
  }

  function record(principal: string) {
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
        principal,
        command: "pod hqa record story:S-1 --generation 1",
        now: () => new Date(),
      },
    );
  }

  async function hqaEvents() {
    return conn.sql<
      { payload: Record<string, unknown> }[]
    >`select payload from ledger.event where type = 'receipt' and source->>'verb' in ('hqa record', 'bypass') order by id`;
  }

  async function nothingWritten() {
    expect(await conn.sql`select id from ledger.gate_receipt`).toEqual([]);
    expect(await hqaEvents()).toEqual([]);
    expect(await taskState(conn, "task_r")).toBe("delivered");
  }

  function cli(env: Record<string, string>) {
    return runCli(["hqa", "record", "story:S-1", "--generation", "1"], env);
  }

  beforeEach(() => setup(operator));

  test("an agent Seat is refused before any tracker or ledger write", async () => {
    const refused = cli({ POD_SEAT: "seat-1" });
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");
    await nothingWritten();
  });

  test("an unrecorded terminal is refused the same way", async () => {
    const refused = cli({ ORCA_TERMINAL_HANDLE: "term-stray" });
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");
    await nothingWritten();
  });

  test("the operator passes the identity check and reaches the tracker check", async () => {
    const reached = cli({});
    expect(reached.status).toBe(2);
    expect(reached.json.error?.code).toBe("usage");
    await nothingWritten();
  });

  test("an operator who is not the gate's keeper is refused before the tracker read", async () => {
    await setup("other");
    expect(await record(operator)).toMatchObject({
      ok: false,
      refusal: {
        code: "receipt_unverified_source",
        message: expect.stringMatching(new RegExp(`other.*${operator}`)),
      },
    });
    expect(tracker.calls).toEqual([]);
    await nothingWritten();
  });

  test("the keeper records the receipt, and its event names the person", async () => {
    expect(await record(operator)).toMatchObject({
      ok: true,
      result: { gate: "pr", receipt_id: expect.any(Number) },
    });
    expect(await hqaEvents()).toMatchObject([
      { payload: { check: "bypass" } },
      { payload: { gate: "pr", actor: `person:${operator}` } },
    ]);
  });
});
