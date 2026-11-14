import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Activity } from "../../src/core/domain/ledger.ts";
import {
  dispatchMinutes,
  readDispatchMinutes,
  sessionMinutes,
} from "../../src/core/usage/minutes.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { seatRun } from "./identity-fixture.ts";

const at = new Date("2026-11-10T08:00:00Z");

function minute(n: number): Date {
  return new Date(at.getTime() + n * 60000);
}

function step(activity: Activity, n: number) {
  return { activity, at: minute(n) };
}

test("running minutes sum the running spans across waiting", () => {
  expect(
    dispatchMinutes({ created_at: at, settled_at: minute(60) }, [
      step("running", 0),
      step("waiting", 10),
      step("running", 25),
      step("waiting", 40),
      step("running", 50),
      step("settled", 60),
    ]),
  ).toEqual({ running_minutes: 35, wall_minutes: 60 });
});

test("a Dispatch with no change since create counts its activity from created_at", () => {
  expect(
    dispatchMinutes({ created_at: at, settled_at: minute(45) }, [
      step("running", 0),
      step("settled", 45),
    ]),
  ).toEqual({ running_minutes: 45, wall_minutes: 45 });
  expect(
    dispatchMinutes({ created_at: at, settled_at: minute(45) }, [
      step("waiting", 0),
      step("settled", 45),
    ]),
  ).toEqual({ running_minutes: 0, wall_minutes: 45 });
});

test("an unsettled Dispatch has both minutes unknown, never 0", () => {
  expect(
    dispatchMinutes({ created_at: at, settled_at: null }, [step("running", 0)]),
  ).toEqual({ running_minutes: null, wall_minutes: null });
});

test("a Dispatch with no origin row has running minutes unknown and wall minutes known", () => {
  expect(
    dispatchMinutes({ created_at: at, settled_at: minute(30) }, [
      step("waiting", 10),
      step("settled", 30),
    ]),
  ).toEqual({ running_minutes: null, wall_minutes: 30 });
  expect(
    dispatchMinutes({ created_at: at, settled_at: minute(30) }, []),
  ).toEqual({ running_minutes: null, wall_minutes: 30 });
});

test("an unattributed session's minutes are its first_at to through", () => {
  expect(sessionMinutes({ first_at: at, through: minute(90) })).toEqual({
    running_minutes: 90,
    wall_minutes: 90,
  });
});

describeDb("dispatch activity history", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    await seatRun(conn.db, "run_a");
  });

  async function insert(dispatchId: string, activity: Activity) {
    await conn.db.insertOperation({
      op_key: `launch:${dispatchId}`,
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
    await conn.db.insertDispatch({
      dispatch_id: dispatchId,
      task_id: null,
      decision_id: null,
      run_id: "run_a",
      seat: "example-seat",
      role: "decider",
      requested_launch: {},
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: `launch:${dispatchId}`,
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity,
      manifest_id: null,
      prompt_bytes: null,
    });
  }

  test("insert, each activity change, and the settle are recorded with their time", async () => {
    await insert("d_1", "running");
    expect(await readDispatchMinutes(conn.db, "d_1")).toEqual({
      running_minutes: null,
      wall_minutes: null,
    });
    await conn.db.setDispatchActivity("d_1", "waiting", minute(10));
    await conn.db.setDispatchActivity("d_1", "running", minute(25));
    expect(
      await conn.db.settleDispatch("d_1", {
        activity: "settled",
        settlement: "done",
        settled_at: minute(40),
        at: minute(40),
      }),
    ).toBe(true);
    expect(
      await conn.db.setDispatchActivity("d_1", "running", minute(50)),
    ).toBe(false);
    expect(await conn.db.listDispatchActivity("d_1")).toEqual([
      step("running", 0),
      step("waiting", 10),
      step("running", 25),
      step("settled", 40),
    ]);
    expect(await readDispatchMinutes(conn.db, "d_1")).toEqual({
      running_minutes: 25,
      wall_minutes: 40,
    });
  });

  test("an open settle that moves activity to waiting is recorded", async () => {
    await insert("d_2", "running");
    await conn.db.settleDispatch("d_2", {
      activity: "waiting",
      settlement: "open",
      settled_at: null,
      at: minute(5),
    });
    expect(await conn.db.listDispatchActivity("d_2")).toEqual([
      step("running", 0),
      step("waiting", 5),
    ]);
  });

  test("a Dispatch from before the history reads running minutes unknown", async () => {
    await insert("d_old", "running");
    await conn.sql`truncate ledger.dispatch_activity`;
    await conn.db.settleDispatch("d_old", {
      activity: "settled",
      settlement: "done",
      settled_at: minute(20),
      at: minute(20),
    });
    expect(await readDispatchMinutes(conn.db, "d_old")).toEqual({
      running_minutes: null,
      wall_minutes: 20,
    });
  });

  test("an unknown Dispatch reads as null", async () => {
    expect(await readDispatchMinutes(conn.db, "d_none")).toBeNull();
  });

  test("the history is append-only", async () => {
    await insert("d_3", "running");
    await expect(
      conn.sql`update ledger.dispatch_activity set activity = 'waiting'`,
    ).rejects.toThrow();
    await expect(
      conn.sql`delete from ledger.dispatch_activity`,
    ).rejects.toThrow();
  });
});
