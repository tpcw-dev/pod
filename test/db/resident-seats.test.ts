import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import {
  openDecisionSeat,
  type SeatInput,
} from "../../src/core/dispatch/decision-seats.ts";
import { insertStart } from "../../src/core/dispatch/launch-record.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { decider, deliveredPlan, opened } from "./decision-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

describeDb("resident decision Seats", () => {
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

  async function resident(
    dispatchId: string,
    role: "decider" | "auditor",
    settlement = "open",
  ) {
    await conn.db.insertOperation({
      op_key: `seat-${dispatchId}`,
      intent: "decide_seat",
      owner_generation: 1,
      at: new Date(),
    });
    await conn.db.moveOperation(`seat-${dispatchId}`, "done", null, new Date());
    await conn.db.insertDispatch({
      dispatch_id: dispatchId,
      task_id: null,
      decision_id: null,
      run_id: "run_1",
      seat: role === "decider" ? "dec-1" : "aud-1",
      role,
      requested_launch: {},
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: `seat-${dispatchId}`,
      settlement,
      terminal_handle: `term_${dispatchId}`,
      created_at: new Date(),
      settled_at: settlement === "open" ? null : new Date(),
      activity: settlement === "open" ? "running" : "settled",
      manifest_id: null,
    });
  }

  async function seat(over: Partial<SeatInput>) {
    const run = await conn.db.getRun("run_1");
    if (run === null) throw new Error("no Run");
    return openDecisionSeat(conn.db, noCalls(), receiptLog(conn.db, "local"), {
      run,
      decisionId: "dec_other",
      role: "decider",
      spec: "spec",
      manifestId: null,
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
      ...over,
    });
  }

  async function seatOps() {
    return conn.sql`select op_key from ledger.operation where intent = 'decide_seat'`;
  }

  test("with no coordinator Dispatch a later Decision reuses an earlier Decision's open Seat, as today", async () => {
    await opened(conn, templates);
    const before = await seatOps();
    const outcome = await seat({});
    expect(outcome).toMatchObject({
      ok: true,
      reused: true,
      dispatch: { dispatch_id: decider },
    });
    expect(await seatOps()).toEqual(before);
  });

  test("on a Run with a coordinator Dispatch a Decision reuses the resident decider and auditor", async () => {
    await resident("ctx_res_dec", "decider");
    await resident("ctx_res_aud", "auditor");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_res_dec",
      coordinator: "term_ctx_res_dec",
    });
    expect(await seat({})).toMatchObject({
      ok: true,
      reused: true,
      dispatch: { dispatch_id: "ctx_res_dec" },
    });
    expect(await seat({ role: "auditor" })).toMatchObject({
      ok: true,
      reused: true,
      dispatch: { dispatch_id: "ctx_res_aud" },
    });
  });

  test("a Decision on a Run whose coordinator Dispatch settled opens no decider and points at takeover", async () => {
    await resident("ctx_res_dec", "decider", "stopped");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_res_dec",
      coordinator: "term_ctx_res_dec",
    });
    const before = await seatOps();
    const outcome = await seat({});
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "task_not_ready",
        message:
          "the Run's coordinator Dispatch ctx_res_dec has settled; pod takeover opens a new one",
      },
    });
    expect(outcome).not.toHaveProperty("runtimeFailure");
    expect(await seatOps()).toEqual(before);
  });

  test("a Seat row with neither a Task nor a Decision is refused for a worker role", async () => {
    await expect(
      conn.db.transaction((tx) =>
        insertStart(tx, {
          owner: { task_id: null, decision_id: null },
          run_id: "run_1",
          role: "developer",
          seat: "dev-1",
          host: "local",
          launched: {
            dispatchId: "ctx_bad",
            terminalHandle: null,
            requested: null,
            effective: null,
            worktreeId: null,
          },
          requested_launch: {},
          model_attribution: "unknown",
          retry_of: null,
          fallback_of: null,
          op_key: "seat-none",
          manifest_id: null,
          verb: "decide",
          late: false,
          at: new Date(),
        }),
      ),
    ).rejects.toThrow("a developer Dispatch needs a Task or a Decision");
  });
});
