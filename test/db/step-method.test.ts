import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import {
  applyOutcome,
  readProcess,
  rework,
} from "../../src/core/process/project.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { replay } from "./run-fixture.ts";
import { activeRevision, crewValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];

const process = {
  summary: "implement, review, pr with one rework",
  selector: { stage: "impl", size: ["xs", "s"] },
  roles: ["developer", "reviewer"],
  steps: [
    {
      id: "implement",
      type: "worker",
      role: "developer",
      method: "Write the failing test first.",
    },
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

const profiled = (method: Json) => ({
  gates: ["review"],
  profiles: { p: { method } },
  active_profile: "p",
});

const today = (step: string, role: string) =>
  `Process rework@1, step ${step}, role ${role}.`;

let clock = Date.parse("2026-11-10T00:00:00.000Z");
const now = () => new Date((clock += 1000));

describeDb("the step method in the TASK block", () => {
  let conn: Connection;
  let policy: Revision;
  let specs: string[];

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  function recording(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const port: OrcaPort = {
      ...orca,
      taskCreate: (request) => {
        specs.push(request.spec);
        return orca.taskCreate(request);
      },
    };
    return { orca, port, log };
  }

  async function createRun(policyValue: Json) {
    await clearDb(conn);
    specs = [];
    policy = await activeRevision(conn.db, "policy", "default", policyValue);
    await activeRevision(conn.db, "crew", "default", crewValue);
    await activeRevision(conn.db, "process", "rework", process);
    const { orca, port, log } = recording([
      ok("run-create", { run: { id: "run_1" } }),
      ok("task-create", { task: { id: "task_i1", status: "ready" } }),
      ok("task-create", { task: { id: "task_r1", status: "pending" } }),
      ok("task-create", { task: { id: "task_p", status: "pending" } }),
    ]);
    const created = await runCreate(conn.db, port, null, log, {
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
    orca.assertDone();
  }

  async function failReview() {
    await conn.sql`update ledger.task set state = 'done' where task_id = 'task_i1'`;
    await conn.sql`update ledger.task set state = 'delivered' where task_id = 'task_r1'`;
    specs = [];
    const { orca, port, log } = recording([
      ok("task-create", { task: { id: "task_i2", status: "ready" } }),
      ok("task-create", { task: { id: "task_r2", status: "pending" } }),
    ]);
    const result = await applyOutcome(conn.db, port, log, {
      task: "task_r1",
      outcome: "FAIL",
      at: now(),
      host: "local",
      source: { kind: "command", verb: "test" },
      command: "pod verdict post",
      now,
    });
    expect(result.ok).toBe(true);
    orca.assertDone();
  }

  describe("with no active profile", () => {
    beforeEach(() => createRun({ gates: ["review"] }));

    test("a step with a method gets one Method line after its spec", () => {
      expect(specs[0]).toBe(
        `${today("implement", "developer")}\n\nMethod: Write the failing test first.`,
      );
    });

    test("a step with no method gets today's spec byte for byte", () => {
      expect(specs.slice(1)).toEqual([
        today("review", "reviewer"),
        today("pr", "developer"),
      ]);
    });

    test("a rework with a note keeps the Method line after the note", async () => {
      const failed = await conn.db.getTask("task_r1");
      if (failed === null) throw new Error("task_r1 missing");
      const read = await readProcess(conn.db, failed, "rework");
      const target = read.value.steps[0];
      if (target === undefined) throw new Error("no implement step");
      specs = [];
      const { orca, port, log } = recording([
        ok("task-create", { task: { id: "task_i2", status: "ready" } }),
      ]);
      const made = await rework(
        {
          db: conn.db,
          orca: port,
          log,
          process: read.revision,
          host: "local",
          command: "pod check",
          source: { kind: "command", verb: "test" },
          now,
        },
        { failed, target, then: null, read, note: "Use the agreed envelope." },
      );
      expect(made.ok).toBe(true);
      orca.assertDone();
      expect(specs).toEqual([
        `${today("implement", "developer")}\n\nUse the agreed envelope.\n\nMethod: Write the failing test first.`,
      ]);
    });
  });

  describe("with an active profile that sets a method", () => {
    beforeEach(() =>
      createRun(
        profiled({
          implement: "Pair the test with the fix.",
          review: "Read the diff twice.",
        }),
      ),
    );

    test("the profile override wins over the step's method and reaches a step with none", () => {
      expect(specs).toEqual([
        `${today("implement", "developer")}\n\nMethod: Pair the test with the fix.`,
        `${today("review", "reviewer")}\n\nMethod: Read the diff twice.`,
        today("pr", "developer"),
      ]);
    });

    test("a policy activated after the Run is created leaves the next Task's method unchanged", async () => {
      const later = await storeRevision(
        conn.db,
        envelope(
          "policy",
          "default",
          profiled({ implement: "A later method.", review: "Skim it." }),
        ),
      );
      const activated = await conn.db.activate({
        scope: "global",
        scope_ref: "",
        kind: "policy",
        name: "default",
        expected: policy.id,
        revision_id: later.id,
        bundle_id: null,
        activated_by: "operator",
        activated_at: now(),
      });
      expect(activated.ok).toBe(true);
      await failReview();
      expect(specs).toEqual([
        `${today("implement", "developer")}\n\nMethod: Pair the test with the fix.`,
        `${today("review", "reviewer")}\n\nMethod: Read the diff twice.`,
      ]);
    });
  });
});
