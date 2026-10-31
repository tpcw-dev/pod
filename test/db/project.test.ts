import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { TaskTransitionInvalid } from "../../src/core/domain/task-state.ts";
import { applyOutcome, recordOutcome } from "../../src/core/process/project.ts";
import type { Outcome } from "../../src/core/process/schema.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { events, freshRun, replay, taskState } from "./run-fixture.ts";
import { activeRevision, crewValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];

const reworkProcess = {
  summary: "implement, review, pr with one rework",
  selector: { stage: "impl", size: ["xs", "s"] },
  roles: ["developer", "reviewer"],
  steps: [
    { id: "implement", type: "worker", role: "developer" },
    {
      id: "review",
      type: "worker",
      role: "reviewer",
      needs: ["implement"],
      gate: "review",
    },
    { id: "pr", type: "worker", role: "developer", needs: ["review"] },
  ],
  edges: [
    { from: "implement", on: "done", to: "review" },
    { from: "implement", on: hold, to: "hold" },
    { from: "review", on: "PASS", to: "pr" },
    {
      from: "review",
      on: "FAIL",
      to: "implement",
      new_task: true,
      then: "review",
    },
    { from: "review", on: hold, to: "hold" },
    { from: "pr", on: "done", to: "done" },
    { from: "pr", on: hold, to: "hold" },
  ],
  limits: { attempts_per_task: 3, rework_per_lineage: 1 },
  escalation: { to: "operator" },
};

let clock = Date.parse("2026-10-30T00:00:00.000Z");
const now = () => new Date((clock += 1000));

function input(task: string, outcome: Outcome) {
  return {
    task,
    outcome,
    at: now(),
    host: "local",
    source: { kind: "command", verb: "test" },
    command: "pod verdict post",
    now,
  };
}

describeDb("applyOutcome", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  const setState = (taskId: string, state: string) =>
    conn.sql`update ledger.task set state = ${state} where task_id = ${taskId}`;

  async function apply(
    entries: readonly TempEntry[],
    task: string,
    outcome: Outcome,
  ) {
    if (entries.length === 0)
      return applyOutcome(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        input(task, outcome),
      );
    const { orca, log } = replay(conn, entries);
    const result = await applyOutcome(conn.db, orca, log, input(task, outcome));
    orca.assertDone();
    return result;
  }

  describe("on the seed process", () => {
    beforeEach(() => freshRun(conn));

    test("a PASS on a delivered gated step walks passed to done and records the edge", async () => {
      await setState("task_b", "done");
      await setState("task_r", "delivered");
      const result = await apply([], "task_r", "PASS");
      expect(result).toMatchObject({
        ok: true,
        result: { state: "done", promoted: [], created: [], replayed: false },
      });
      expect(await taskState(conn, "task_r")).toBe("done");
      expect((await events(conn, "outcome")).map((row) => row.payload)).toEqual(
        [
          {
            task_id: "task_r",
            step_id: "review",
            lineage_id: "run_1:review",
            outcome: "PASS",
            edge: { to: "done", new_task: false, then: null },
          },
        ],
      );
      expect(await apply([], "task_r", "PASS")).toMatchObject({
        ok: true,
        result: { state: "done", replayed: true },
      });
      expect(await events(conn, "outcome")).toHaveLength(1);
    });

    test("a done on an ungated step promotes the pending Task whose deps are now done", async () => {
      await setState("task_b", "delivered");
      const result = await apply([], "task_b", "done");
      expect(result).toMatchObject({
        ok: true,
        result: { state: "done", promoted: ["task_r"] },
      });
      expect(await taskState(conn, "task_r")).toBe("ready");
    });

    test("a FAIL whose edge targets hold holds the Task with reason edge", async () => {
      await setState("task_b", "done");
      await setState("task_r", "delivered");
      expect(await apply([], "task_r", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", replayed: false },
      });
      expect(await taskState(conn, "task_r")).toBe("hold");
      expect((await events(conn, "hold")).at(-1)?.payload).toEqual({
        reason: "edge",
        outcome: "FAIL",
        from: "delivered",
      });
      expect(await apply([], "task_r", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", replayed: true },
      });
      expect(await events(conn, "hold")).toHaveLength(1);
    });

    test("an outcome with no edge throws TaskTransitionInvalid naming the step", async () => {
      await setState("task_r", "delivered");
      await expect(
        conn.db.transaction((tx) => recordOutcome(tx, input("task_r", "done"))),
      ).rejects.toThrow(/step review has no edge for done/);
      await expect(
        conn.db.transaction((tx) => recordOutcome(tx, input("task_x", "done"))),
      ).rejects.toBeInstanceOf(TaskTransitionInvalid);
    });

    test("a done on a Task that is not delivered throws and writes nothing", async () => {
      await expect(apply([], "task_b", "done")).rejects.toThrow(
        "Task task_b cannot move from ready to passed",
      );
      expect(await taskState(conn, "task_b")).toBe("ready");
      expect(await events(conn, "outcome")).toHaveLength(0);
    });
  });

  describe("on a process whose review FAIL reworks implement", () => {
    beforeEach(async () => {
      await clearDb(conn);
      await activeRevision(conn.db, "policy", "default", { gates: ["review"] });
      await activeRevision(conn.db, "crew", "default", crewValue);
      await activeRevision(conn.db, "process", "rework", reworkProcess);
      const { orca, log } = replay(conn, [
        ok("run-create", { run: { id: "run_1" } }),
        ok("task-create", { task: { id: "task_i1", status: "ready" } }),
        ok("task-create", { task: { id: "task_r1", status: "pending" } }),
        ok("task-create", { task: { id: "task_p", status: "pending" } }),
      ]);
      const created = await runCreate(conn.db, orca, log, {
        story: "S-1",
        process: { name: "rework", rev: 1 },
        size: "s",
        stage: "impl",
        coordinator: "session-1",
        host: "local",
        provider: "linear",
        command: "pod run create story:S-1",
        now,
      });
      if (!created.ok) throw new Error(created.refusal.message);
      await setState("task_i1", "done");
      await setState("task_r1", "delivered");
    });

    const reworkCreates = [
      ok("task-create", { task: { id: "task_i2", status: "ready" } }, [
        "--task-title",
        "implement",
      ]),
      ok("task-create", { task: { id: "task_r2", status: "pending" } }, [
        "--deps",
        JSON.stringify(["task_i2"]),
        "--task-title",
        "review",
      ]),
    ];

    test("a FAIL fails the review, opens a rework implement and review, and repoints pr", async () => {
      const result = await apply(reworkCreates, "task_r1", "FAIL");
      expect(result).toMatchObject({
        ok: true,
        result: {
          state: "failed",
          created: ["task_i2", "task_r2"],
          replayed: false,
        },
      });
      expect(await conn.db.getTask("task_r1")).toMatchObject({
        state: "failed",
      });
      expect(await conn.db.getTask("task_i2")).toMatchObject({
        lineage_id: "run_1:implement",
        rework_of: "task_i1",
        deps: [],
        state: "ready",
      });
      expect(await conn.db.getTask("task_r2")).toMatchObject({
        lineage_id: "run_1:review",
        rework_of: "task_r1",
        deps: ["task_i2"],
        state: "pending",
      });
      expect(await conn.db.getTask("task_p")).toMatchObject({
        deps: ["task_r2"],
        state: "pending",
      });
      expect((await events(conn, "outcome")).at(-1)?.payload).toMatchObject({
        outcome: "FAIL",
        edge: { to: "implement", new_task: true, then: "review" },
      });
    });

    test("a replayed FAIL creates nothing twice", async () => {
      await apply(reworkCreates, "task_r1", "FAIL");
      expect(await apply([], "task_r1", "FAIL")).toMatchObject({
        ok: true,
        result: {
          state: "failed",
          created: ["task_i2", "task_r2"],
          replayed: true,
        },
      });
      expect(await conn.db.listTasks("run_1")).toHaveLength(5);
      expect(await events(conn, "outcome")).toHaveLength(1);
    });

    test("a FAIL at the rework limit holds the review with reason rework_limit and creates nothing", async () => {
      await apply(reworkCreates, "task_r1", "FAIL");
      await setState("task_i2", "done");
      await setState("task_r2", "delivered");
      expect(await apply([], "task_r2", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", created: [] },
      });
      expect(await taskState(conn, "task_r2")).toBe("hold");
      expect((await events(conn, "hold")).at(-1)?.payload).toEqual({
        reason: "rework_limit",
        lineage_id: "run_1:implement",
        from: "delivered",
      });
      expect(await conn.db.listTasks("run_1")).toHaveLength(5);
      expect(await apply([], "task_r2", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", replayed: true },
      });
    });

    test("an unknown task-create holds the Run, and the replay stops on the open op", async () => {
      expect(
        await apply([unknownReply("task-create", "req_1")], "task_r1", "FAIL"),
      ).toMatchObject({ ok: false, refusal: { code: "launch_unknown" } });
      expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
      expect(await taskState(conn, "task_r1")).toBe("failed");
      expect(
        await apply(
          [ok("request-show", { requestId: "req_1", state: "pending" })],
          "task_r1",
          "FAIL",
        ),
      ).toMatchObject({ ok: false, refusal: { code: "launch_unknown" } });
      expect(await conn.db.listTasks("run_1")).toHaveLength(3);
    });
  });
});
