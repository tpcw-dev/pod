import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { parseYaml } from "../../src/cli/yaml-file.ts";
import { revisionId } from "../../src/core/config/canonical-json.ts";
import { RevisionEnvelope } from "../../src/core/domain/config.ts";
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
import { created, mergeRun } from "./merge-fixture.ts";
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
  limits: { attempts_per_task: 3, rework_per_lineage: 2 },
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
      const created = await runCreate(conn.db, orca, null, log, {
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

    test("replacements of superseded Tasks do not count against rework_per_lineage", async () => {
      const copy = (id: string, state: string, reworkOf: string | null) =>
        conn.sql`
          insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
          select ${id}, run_id, step_id, lineage_id, role, deps, spec_revision_id, ${state}, ${reworkOf}, created_at
          from ledger.task where task_id = 'task_i1'`;
      await copy("task_s0", "superseded", null);
      await copy("task_s1", "superseded", "task_s0");
      await copy("task_s2", "done", "task_s1");
      const result = await apply(reworkCreates, "task_r1", "FAIL");
      expect(result).toMatchObject({
        ok: true,
        result: { state: "failed", created: ["task_i2", "task_r2"] },
      });
    });

    test("a rework after a change_spec replacement keeps the agreed Task spec Revision", async () => {
      const envelope = {
        kind: "task" as const,
        name: "run_1:implement",
        schema_version: 1,
        scope: "run" as const,
        scope_ref: "run_1",
        parent: null,
        value: { spec: "Implement it with the agreed error envelope." },
      };
      const { revision } = await conn.db.insertRevision({
        ...envelope,
        id: revisionId(envelope),
        actor: "pod decide",
        reason: "pod decide --effect change_spec",
      });
      await setState("task_i1", "superseded");
      await conn.sql`
        insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
        select 'task_i1b', run_id, step_id, lineage_id, role, deps, ${revision.id}, 'done', 'task_i1', created_at
        from ledger.task where task_id = 'task_i1'`;
      const result = await apply(
        [
          ok("task-create", { task: { id: "task_i2", status: "ready" } }, [
            "--spec",
            "Implement it with the agreed error envelope.",
            "--task-title",
            "implement",
          ]),
          reworkCreates[1] as TempEntry,
        ],
        "task_r1",
        "FAIL",
      );
      expect(result).toMatchObject({
        ok: true,
        result: { created: ["task_i2", "task_r2"] },
      });
      expect(await conn.db.getTask("task_i2")).toMatchObject({
        rework_of: "task_i1b",
        spec_revision_id: revision.id,
      });
      expect((await conn.db.getTask("task_r2"))?.spec_revision_id).not.toBe(
        revision.id,
      );
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

    test("a second rework follows the rework_of chain when created_at ties, and the FAIL at the limit holds", async () => {
      await apply(
        [
          ok("task-create", { task: { id: "task_0i", status: "ready" } }),
          ok("task-create", { task: { id: "task_0r", status: "pending" } }),
        ],
        "task_r1",
        "FAIL",
      );
      await conn.sql`update ledger.task set created_at = (select created_at from ledger.task where task_id = 'task_i1') where task_id in ('task_0i', 'task_0r')`;
      await conn.sql`update ledger.task set created_at = (select created_at from ledger.task where task_id = 'task_r1') where task_id = 'task_0r'`;
      await setState("task_0i", "done");
      await setState("task_0r", "delivered");
      expect(
        await apply(
          [
            ok("task-create", { task: { id: "task_a3", status: "ready" } }),
            ok("task-create", { task: { id: "task_a4", status: "pending" } }),
          ],
          "task_0r",
          "FAIL",
        ),
      ).toMatchObject({
        ok: true,
        result: { created: ["task_a3", "task_a4"] },
      });
      expect(await conn.db.getTask("task_a3")).toMatchObject({
        rework_of: "task_0i",
      });
      expect(await conn.db.getTask("task_a4")).toMatchObject({
        rework_of: "task_0r",
        deps: ["task_a3"],
      });
      expect(await conn.db.getTask("task_p")).toMatchObject({
        deps: ["task_a4"],
      });

      await setState("task_a3", "done");
      await setState("task_a4", "delivered");
      expect(await apply([], "task_a4", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", created: [] },
      });
      expect(await taskState(conn, "task_a4")).toBe("hold");
      expect((await events(conn, "hold")).at(-1)?.payload).toEqual({
        reason: "rework_limit",
        lineage_id: "run_1:implement",
        from: "delivered",
      });
      expect(await conn.db.listTasks("run_1")).toHaveLength(7);
      expect(await apply([], "task_a4", "FAIL")).toMatchObject({
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

  describe("on a process whose merge FAIL reworks implement then review", () => {
    const deps = (ids: string[]) => ["--deps", JSON.stringify(ids)];
    const mergeCreates = [
      created("task_i2"),
      ok("task-create", { task: { id: "task_r2", status: "pending" } }, [
        ...deps(["task_i2"]),
        "--task-title",
        "review",
      ]),
      ok("task-create", { task: { id: "task_m2", status: "pending" } }, [
        ...deps(["task_r2"]),
        "--task-title",
        "merge",
      ]),
    ];

    test("a merge FAIL re-arms the merge gate after the rework review, and land waits on the new merge Task", async () => {
      await mergeRun(conn);
      await setState("task_m", "delivered");
      expect(await apply(mergeCreates, "task_m", "FAIL")).toMatchObject({
        ok: true,
        result: {
          state: "failed",
          created: ["task_i2", "task_r2", "task_m2"],
          replayed: false,
        },
      });
      expect(await conn.db.getTask("task_m2")).toMatchObject({
        step_id: "merge",
        lineage_id: "run_1:merge",
        rework_of: "task_m",
        deps: ["task_r2"],
        state: "pending",
      });
      expect(await conn.db.getTask("task_l")).toMatchObject({
        deps: ["task_m2"],
        state: "pending",
      });
    });

    test("a FAIL whose then step is two steps above the failed step re-creates each step between them", async () => {
      await mergeRun(conn, { withPr: true });
      await setState("task_m", "delivered");
      const result = await apply(
        [
          ...mergeCreates.slice(0, 2),
          ok("task-create", { task: { id: "task_p2", status: "pending" } }, [
            ...deps(["task_r2"]),
            "--task-title",
            "pr",
          ]),
          ok("task-create", { task: { id: "task_m2", status: "pending" } }, [
            ...deps(["task_p2"]),
            "--task-title",
            "merge",
          ]),
        ],
        "task_m",
        "FAIL",
      );
      expect(result).toMatchObject({
        ok: true,
        result: { created: ["task_i2", "task_r2", "task_p2", "task_m2"] },
      });
      expect(await conn.db.getTask("task_p2")).toMatchObject({
        rework_of: "task_p",
        deps: ["task_r2"],
      });
      expect(await conn.db.getTask("task_m2")).toMatchObject({
        rework_of: "task_m",
        deps: ["task_p2"],
      });
      expect(await conn.db.getTask("task_l")).toMatchObject({
        deps: ["task_m2"],
      });
    });

    test("a replayed merge FAIL creates no Task twice", async () => {
      await mergeRun(conn);
      await setState("task_m", "delivered");
      await apply(mergeCreates, "task_m", "FAIL");
      expect(await apply([], "task_m", "FAIL")).toMatchObject({
        ok: true,
        result: {
          state: "failed",
          created: ["task_i2", "task_r2", "task_m2"],
          replayed: true,
        },
      });
      expect(await conn.db.listTasks("run_1")).toHaveLength(7);
      expect(await events(conn, "outcome")).toHaveLength(1);
    });

    test("a merge FAIL at the rework limit holds the merge Task and re-arms nothing", async () => {
      await mergeRun(conn, { rework: 1 });
      await conn.sql`
        insert into ledger.task (task_id, run_id, step_id, lineage_id, role, deps, spec_revision_id, state, rework_of, created_at)
        select 'task_i1', run_id, step_id, lineage_id, role, deps, spec_revision_id, 'done', 'task_i', created_at
        from ledger.task where task_id = 'task_i'`;
      await setState("task_m", "delivered");
      expect(await apply([], "task_m", "FAIL")).toMatchObject({
        ok: true,
        result: { state: "hold", created: [] },
      });
      expect(await taskState(conn, "task_m")).toBe("hold");
      expect(await conn.db.listTasks("run_1")).toHaveLength(5);
      expect(await conn.db.getTask("task_l")).toMatchObject({
        deps: ["task_m"],
      });
    });

    test("after the rework review passes, land stays pending until the new merge Task passes", async () => {
      await mergeRun(conn);
      await setState("task_m", "delivered");
      await apply(mergeCreates, "task_m", "FAIL");
      await setState("task_i2", "done");
      await setState("task_r2", "delivered");
      expect(await apply([], "task_r2", "PASS")).toMatchObject({
        ok: true,
        result: { state: "done", promoted: ["task_m2"] },
      });
      expect(await taskState(conn, "task_l")).toBe("pending");
      await setState("task_m2", "delivered");
      expect(await apply([], "task_m2", "PASS")).toMatchObject({
        ok: true,
        result: { state: "done", promoted: ["task_l"] },
      });
      expect(await taskState(conn, "task_l")).toBe("ready");
    });
  });

  describe("on a seeded process whose gate sits below its FAIL edge's then step", () => {
    function seed(name: string) {
      const path = `specs/process/${name}.yaml`;
      const envelope = RevisionEnvelope.parse(
        parseYaml(readFileSync(path, "utf8"), path),
      );
      return envelope.value as {
        steps: { id: string; needs?: string[]; after?: string }[];
      };
    }

    test.each([
      [
        "impl-small",
        "hqa",
        "impl",
        "s",
        ["implement", "review", "pr", "merge", "deploy", "hqa"],
      ],
      [
        "impl-large",
        "integration_review",
        "impl",
        "l",
        ["implement", "review", "integration_review"],
      ],
      ["prd", "prd_review", "prd", "s", ["draft", "audit", "prd_review"]],
      [
        "design",
        "design_clickthrough",
        "design",
        "s",
        ["design", "taste_qa", "design_clickthrough"],
      ],
    ])(
      "%s: a %s FAIL re-arms the gate with no receipt, and its dependents wait on it",
      async (name, failed, stage, size, rearmed) => {
        const value = seed(name);
        const steps = value.steps.filter((step) => step.after === undefined);
        await clearDb(conn);
        await activeRevision(conn.db, "policy", "default", { gates: [] });
        await activeRevision(conn.db, "crew", "default", crewValue);
        await activeRevision(conn.db, "process", name, value);
        const { orca, log } = replay(conn, [
          ok("run-create", { run: { id: "run_1" } }),
          ...steps.map((step) => created(`t_${step.id}`)),
        ]);
        const made = await runCreate(conn.db, orca, null, log, {
          story: "S-1",
          process: { name, rev: 1 },
          size: size as "s" | "l",
          stage,
          coordinator: "session-1",
          host: "local",
          provider: "linear",
          command: "pod run create story:S-1",
          now,
        });
        if (!made.ok) throw new Error(made.refusal.message);
        const at = steps.findIndex((step) => step.id === failed);
        for (const step of steps.slice(0, at))
          await setState(`t_${step.id}`, "done");
        await setState(`t_${failed}`, "delivered");

        expect(
          await apply(
            rearmed.map((id) => created(`n_${id}`)),
            `t_${failed}`,
            "FAIL",
          ),
        ).toMatchObject({
          ok: true,
          result: { created: rearmed.map((id) => `n_${id}`) },
        });
        const gate = await conn.db.getTask(`n_${failed}`);
        expect(gate).toMatchObject({
          step_id: failed,
          rework_of: `t_${failed}`,
          state: "pending",
        });
        expect(
          await conn.sql`select id from ledger.gate_receipt where task_id = ${`n_${failed}`}`,
        ).toHaveLength(0);
        for (const id of rearmed.slice(2)) {
          const step = steps.find((row) => row.id === id);
          expect((await conn.db.getTask(`n_${id}`))?.deps).toEqual(
            (step?.needs ?? []).map((need) => `n_${need}`),
          );
        }
        const live = (await conn.db.listTasks("run_1")).filter(
          (row) =>
            !["done", "failed", "superseded"].includes(row.state) &&
            (row.deps as string[]).includes(`t_${failed}`),
        );
        expect(live).toEqual([]);
      },
    );
  });
});
