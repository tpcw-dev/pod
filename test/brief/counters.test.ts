import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { countRun, measureRun } from "../../src/core/brief/counters.ts";
import type { Story, Run, Task } from "../../src/core/domain/ledger.ts";
import type { TaskState } from "../../src/core/domain/task-state.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const at = new Date("2026-10-31T00:00:00.000Z");
const later = new Date("2026-10-31T00:00:01.000Z");

const zeros = {
  coordinator_operations: 0,
  recovery_steps: 0,
  retries: 0,
  rework_tasks: 0,
  hand_filled: 0,
  fallback_launches: 0,
  model_mismatches: 0,
};

test("an empty Run counts zeros", () => {
  expect(countRun({ run_id: "run-a" }, [], [], [], [])).toEqual(zeros);
});

test("an event from another Run is ignored", () => {
  expect(
    countRun(
      { run_id: "run-a" },
      [],
      [],
      [
        {
          run_id: "run-b",
          type: "retry",
          op_key: "op-retry",
          source: { kind: "command", verb: "retry" },
        },
      ],
      [{ op_key: "op-retry" }],
    ),
  ).toEqual(zeros);
});

test("a start carrying fallback_of counts a fallback launch", () => {
  const start = (payload: Record<string, string>) => ({
    run_id: "run-a",
    type: "start" as const,
    op_key: null,
    source: { kind: "command", verb: "decide" },
    payload,
  });
  expect(
    countRun(
      { run_id: "run-a" },
      [],
      [],
      [
        start({ seat: "dec-fb", fallback_of: "dec-1" }),
        start({ seat: "aud-1" }),
      ],
      [],
    ).fallback_launches,
  ).toBe(1);
});

test("a receipt-attributed Dispatch whose effective model differs from the requested one counts a mismatch", () => {
  const row = (
    requested: string,
    effective: string,
    attribution: "receipt" | "unknown",
  ) => ({
    run_id: "run-a",
    op_key: `op-${requested}-${effective}-${attribution}`,
    requested_launch: { agent: "claude", model: requested },
    effective_launch: { agent: "claude", model: effective },
    model_attribution: attribution,
  });
  expect(
    countRun(
      { run_id: "run-a" },
      [],
      [
        row("m-1", "m-2", "receipt"),
        row("m-1", "m-1", "receipt"),
        row("m-1", "m-2", "unknown"),
      ],
      [],
      [],
    ).model_mismatches,
  ).toBe(1);
});

test("a hand-filled source that is not a command does not count", () => {
  expect(
    countRun(
      { run_id: "run-a" },
      [],
      [],
      [
        {
          run_id: "run-a",
          type: "receipt",
          op_key: null,
          source: { kind: "relay", verb: "hqa record" },
        },
      ],
      [],
    ).hand_filled,
  ).toBe(0);
});

describeDb("brief counters", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    const story: Story = {
      provider: "tracker",
      external_id: "S-counters",
      size: "s",
      stage: "impl",
      run_id: "run-a",
      dependencies: [],
      synced_at: at,
      status: null,
      title: null,
      kickoff_line: null,
    };
    const runOf = (run_id: string): Run => ({
      run_id,
      story_provider: "tracker",
      story_external_id: "S-counters",
      host: "local",
      coordinator: "session-1",
      owner_generation: 1,
      snapshot_hash: "pending",
      state: "active",
      created_at: at,
      coordinator_dispatch_id: null,
    });
    await conn.db.upsertStory(story);
    await conn.db.insertRun(runOf("run-a"));
    await conn.db.insertRun(runOf("run-b"));
    const spec = await storeRevision(
      conn.db,
      envelope("task", "lineage-a", { goal: "build" }),
    );
    const taskOf = (task_id: string, created_at: Date): Task => ({
      task_id,
      run_id: "run-a",
      step_id: "build",
      lineage_id: "lineage-a",
      role: "developer",
      deps: [],
      spec_revision_id: spec.id,
      rework_of: null,
      state: "ready",
      created_at,
    });
    await conn.db.insertTask(taskOf("task-1", at));
    await conn.db.insertTask(taskOf("task-2", later));
    for (const op_key of ["op-retry", "op-take", "op-hqa", "op-other"]) {
      await conn.db.insertOperation({
        op_key,
        intent: op_key === "op-other" ? "dispatch" : "hqa",
        owner_generation: 1,
        at,
      });
    }
    const source = (verb: string) => ({ kind: "command", verb });
    await conn.db.appendEvent({
      type: "retry",
      ts: at,
      host: "local",
      run_id: "run-a",
      task_id: "task-2",
      dispatch_id: null,
      op_key: "op-retry",
      payload: {},
      source: source("retry"),
    });
    await conn.db.appendEvent({
      type: "takeover",
      ts: at,
      host: "local",
      run_id: "run-a",
      task_id: null,
      dispatch_id: null,
      op_key: "op-take",
      payload: {},
      source: source("takeover"),
    });
    await conn.db.appendEvent({
      type: "receipt",
      ts: at,
      host: "local",
      run_id: "run-a",
      task_id: null,
      dispatch_id: null,
      op_key: "op-hqa",
      payload: {},
      source: source("hqa record"),
    });
    await conn.db.appendEvent({
      type: "resume",
      ts: at,
      host: "local",
      run_id: "run-b",
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { reason: "operator" },
      source: source("check --resume"),
    });
  });
  afterAll(() => conn.close());

  test("pod brief prints the Run counters and the Story sum", () => {
    const result = runCli(["brief", "story:S-counters"]);
    expect(result.status).toBe(0);
    expect(result.json.result).toMatchObject({
      stories: [
        {
          external_id: "S-counters",
          counters: {
            coordinator_operations: 3,
            recovery_steps: 3,
            retries: 1,
            rework_tasks: 1,
            hand_filled: 3,
          },
          runs: [
            {
              run_id: "run-a",
              counters: {
                coordinator_operations: 3,
                recovery_steps: 2,
                retries: 1,
                rework_tasks: 1,
                hand_filled: 2,
              },
            },
            {
              run_id: "run-b",
              counters: {
                coordinator_operations: 0,
                recovery_steps: 1,
                retries: 0,
                rework_tasks: 0,
                hand_filled: 1,
              },
            },
          ],
        },
      ],
    });
  });
});

const pairRun = { run_id: "run-a", coordinator_dispatch_id: "ctx-dec" };

function seat(
  dispatch_id: string,
  role: string,
  over: Partial<{
    seat: string;
    prompt_bytes: number | null;
    created_at: Date;
    decision_id: string | null;
    op_key: string;
  }> = {},
) {
  return {
    dispatch_id,
    run_id: "run-a",
    seat: over.seat ?? `${role}-1`,
    role,
    decision_id: over.decision_id ?? null,
    op_key: over.op_key ?? `op-${dispatch_id}`,
    prompt_bytes: over.prompt_bytes ?? null,
    created_at: over.created_at ?? later,
  };
}

function decision(
  id: string,
  state: string,
  over: Partial<{
    task_id: string | null;
    reason: string | null;
    effect: string;
    supersedes_decision_id: string | null;
  }> = {},
) {
  return {
    id,
    task_id: over.task_id ?? null,
    state,
    reason: over.reason ?? null,
    effect: over.effect ?? "accept_plan",
    supersedes_decision_id: over.supersedes_decision_id ?? null,
  };
}

function task(
  task_id: string,
  state: TaskState = "done",
  rework_of: string | null = null,
) {
  return { task_id, state, rework_of };
}

function outcomes(
  decisions: ReturnType<typeof decision>[],
  tasks: ReturnType<typeof task>[] = [],
) {
  return measureRun(pairRun, tasks, [], [], [], decisions).decisions.map(
    (row) => [row.decision_id, row.outcome],
  );
}

test("a Run with no coordinator Dispatch has no pair measurement", () => {
  expect(
    measureRun(
      { run_id: "run-a", coordinator_dispatch_id: null },
      [],
      [seat("ctx-dec", "decider")],
      [],
      [],
      [],
    ).pair,
  ).toBeNull();
});

test("the pair carries each Seat's prompt bytes and its cold start from the operation to the Dispatch row", () => {
  const opened = new Date("2026-10-31T00:00:00.000Z");
  const measured = measureRun(
    pairRun,
    [],
    [
      seat("ctx-dec", "decider", {
        seat: "dec-1",
        prompt_bytes: 812,
        created_at: new Date("2026-10-31T00:00:02.500Z"),
      }),
      seat("ctx-aud", "auditor", {
        seat: "aud-1",
        prompt_bytes: 640,
        created_at: new Date("2026-10-31T00:00:04.000Z"),
      }),
      seat("ctx-aud-old", "auditor", {
        seat: "aud-old",
        created_at: new Date("2026-10-31T00:00:01.000Z"),
      }),
      seat("ctx-per-decision", "auditor", {
        decision_id: "dec-x",
        created_at: new Date("2026-10-31T00:00:09.000Z"),
      }),
    ],
    [],
    [
      { op_key: "op-ctx-dec", created_at: opened },
      { op_key: "op-ctx-aud", created_at: opened },
    ],
    [],
  );
  expect(measured.pair).toEqual({
    decider: { seat: "dec-1", prompt_bytes: 812, cold_start_ms: 2500 },
    auditor: { seat: "aud-1", prompt_bytes: 640, cold_start_ms: 4000 },
  });
});

test("a Seat whose operation row is missing has a null cold start", () => {
  const measured = measureRun(
    pairRun,
    [],
    [seat("ctx-dec", "decider")],
    [],
    [],
    [],
  );
  expect(measured.pair).toEqual({
    decider: { seat: "decider-1", prompt_bytes: null, cold_start_ms: null },
    auditor: null,
  });
});

test("an agreed Decision whose Task has no rework Task is adopted", () => {
  expect(
    outcomes(
      [decision("d1", "agreed", { task_id: "t1", reason: "agreed" })],
      [task("t1")],
    ),
  ).toEqual([["d1", "adopted"]]);
});

test("an agreed Decision whose Task gained a rework Task after a review FAIL is reworked", () => {
  expect(
    outcomes(
      [decision("d1", "agreed", { task_id: "t1" })],
      [task("t1", "failed"), task("t1-rework", "ready", "t1")],
    ),
  ).toEqual([["d1", "reworked"]]);
});

test("an agreed change_spec Decision's replacement Task is not rework, and rework of the replacement is", () => {
  const agreed = decision("d1", "agreed", {
    task_id: "t1",
    effect: "change_spec",
  });
  expect(
    outcomes([agreed], [task("t1", "superseded"), task("t2", "ready", "t1")]),
  ).toEqual([["d1", "adopted"]]);
  expect(
    outcomes(
      [agreed],
      [
        task("t1", "superseded"),
        task("t2", "failed", "t1"),
        task("t3", "ready", "t2"),
      ],
    ),
  ).toEqual([["d1", "reworked"]]);
});

test("a Decision superseded by a later change_spec Decision is reversed", () => {
  expect(
    outcomes([
      decision("d1", "superseded", { reason: "superseded" }),
      decision("d2", "agreed", {
        effect: "change_spec",
        supersedes_decision_id: "d1",
      }),
    ]),
  ).toEqual([
    ["d1", "reversed"],
    ["d2", "adopted"],
  ]);
});

test("a Decision superseded by an accept_plan Decision is open, as is any state other than agreed", () => {
  expect(
    outcomes([
      decision("d1", "superseded"),
      decision("d2", "round:1", { supersedes_decision_id: "d1" }),
      decision("d3", "needs_human", { reason: "disagreement" }),
    ]),
  ).toEqual([
    ["d1", "open"],
    ["d2", "open"],
    ["d3", "open"],
  ]);
});

test("a rework_of cycle ends the replacement walk", () => {
  expect(
    outcomes(
      [decision("d1", "agreed", { task_id: "t1" })],
      [task("t1", "superseded", "t2"), task("t2", "superseded", "t1")],
    ),
  ).toEqual([["d1", "reworked"]]);
});

test("each needs_human reason counts in its bucket, escalate events count as worker, and the sample is the Decision count", () => {
  const reasons = [
    "policy-required",
    "disagreement",
    "context-missing",
    "runtime-failure",
  ];
  const measured = measureRun(
    pairRun,
    [],
    [],
    [
      { run_id: "run-a", type: "escalate" },
      { run_id: "run-a", type: "escalate" },
      { run_id: "run-b", type: "escalate" },
      { run_id: "run-a", type: "decision" },
    ],
    [],
    [
      ...reasons.map((reason, index) =>
        decision(`n${index}`, "needs_human", { reason }),
      ),
      decision("n-extra", "needs_human", { reason: "disagreement" }),
      decision("n-none", "needs_human"),
      decision("cancelled", "cancelled", { reason: "policy-required" }),
    ],
  );
  expect(measured.escalations).toEqual({
    "policy-required": 1,
    disagreement: 2,
    "context-missing": 1,
    "runtime-failure": 1,
    worker: 2,
    sample: 7,
    target: 10,
  });
});

test("each Decision row carries its id, state, reason, and effect", () => {
  expect(
    measureRun(
      pairRun,
      [],
      [],
      [],
      [],
      [
        decision("d1", "needs_human", {
          reason: "context-missing",
          effect: "change_spec",
        }),
      ],
    ).decisions,
  ).toEqual([
    {
      decision_id: "d1",
      state: "needs_human",
      reason: "context-missing",
      effect: "change_spec",
      outcome: "open",
    },
  ]);
});
