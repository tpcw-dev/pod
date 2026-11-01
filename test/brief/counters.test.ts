import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { countRun } from "../../src/core/brief/counters.ts";
import type { Story, Run, Task } from "../../src/core/domain/ledger.ts";
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
