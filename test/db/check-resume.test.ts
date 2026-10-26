import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { resume, type ResumeInput } from "../../src/core/check/check.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { events, freshRun, taskState } from "./run-fixture.ts";

function input(over: Partial<ResumeInput>): ResumeInput {
  return {
    run: null,
    task: null,
    generation: 1,
    host: "local",
    now: () => new Date(),
    ...over,
  };
}

describeDb("pod check --resume", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  test("the Task form moves one held Task to ready with a resume event", async () => {
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(await resume(conn.db, input({ task: "task_b" }))).toEqual({
      ok: true,
      result: { run_id: "run_1", resumed: [{ kind: "task", id: "task_b" }] },
    });
    expect(await taskState(conn, "task_b")).toBe("ready");
    expect(await taskState(conn, "task_r")).toBe("hold");
    expect((await events(conn, "resume")).map((row) => row.task_id)).toEqual([
      "task_b",
    ]);
  });

  test("the Run form makes the Run active and every held Task ready, one event per row", async () => {
    await conn.sql`update ledger.run set state = 'hold'`;
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(await resume(conn.db, input({ run: "run_1" }))).toMatchObject({
      ok: true,
      result: {
        resumed: [
          { kind: "run", id: "run_1" },
          { kind: "task", id: "task_b" },
          { kind: "task", id: "task_r" },
        ],
      },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("active");
    expect(await taskState(conn, "task_r")).toBe("ready");
    expect((await events(conn, "resume")).map((row) => row.task_id)).toEqual([
      null,
      "task_b",
      "task_r",
    ]);
  });

  test("a row not in hold is task_not_ready naming its state, and nothing moves", async () => {
    expect(await resume(conn.db, input({ task: "task_b" }))).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", nextSteps: ["Task state ready"] },
    });
    expect(await resume(conn.db, input({ run: "run_1" }))).toMatchObject({
      ok: false,
      refusal: { code: "task_not_ready", nextSteps: ["Run state active"] },
    });
    expect(await events(conn, "resume")).toEqual([]);
  });

  test("a stale generation is owner_generation_stale", async () => {
    await conn.sql`update ledger.task set state = 'hold'`;
    expect(
      await resume(conn.db, input({ task: "task_b", generation: 2 })),
    ).toMatchObject({ ok: false, refusal: { code: "owner_generation_stale" } });
    expect(await taskState(conn, "task_b")).toBe("hold");
  });
});
