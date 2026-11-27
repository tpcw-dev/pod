import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { applyOutcome } from "../../src/core/process/project.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import type { FakeTracker } from "./fake-tracker.ts";
import { clearDb } from "./helpers.ts";
import { replay } from "./run-fixture.ts";
import { activeRevision, crewValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];

export const oldHead = "1111111111111111111111111111111111111111";
export const newHead = "2222222222222222222222222222222222222222";

export const mergeGates = {
  review: { keeper: "rev-1", type: "AQA" },
  merge: { keeper: "human", type: "HQA" },
};
export const mergePrincipals = { human: { tracker_account: "keeper-1" } };

export function mergeProcess(withPr = false, rework = 3) {
  const above = withPr ? "pr" : "review";
  return {
    summary: "implement, review, merge, land",
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
      ...(withPr
        ? [{ id: "pr", type: "worker", role: "developer", needs: ["review"] }]
        : []),
      { id: "merge", type: "human_wait", needs: [above], gate: "merge" },
      { id: "land", type: "worker", role: "developer", needs: ["merge"] },
    ],
    edges: [
      { from: "implement", on: "done", to: "review" },
      { from: "implement", on: hold, to: "hold" },
      { from: "review", on: "PASS", to: withPr ? "pr" : "merge" },
      {
        from: "review",
        on: "FAIL",
        to: "implement",
        new_task: true,
        then: "review",
      },
      { from: "review", on: hold, to: "hold" },
      ...(withPr
        ? [
            { from: "pr", on: "done", to: "merge" },
            { from: "pr", on: hold, to: "hold" },
          ]
        : []),
      { from: "merge", on: "PASS", to: "land" },
      {
        from: "merge",
        on: "FAIL",
        to: "implement",
        new_task: true,
        then: "review",
      },
      { from: "merge", on: "cancel", to: "hold" },
      { from: "land", on: "done", to: "done" },
      { from: "land", on: hold, to: "hold" },
    ],
    limits: { attempts_per_task: 3, rework_per_lineage: rework },
    escalation: { to: "operator" },
  };
}

export const setState = (conn: Connection, taskId: string, state: string) =>
  conn.sql`update ledger.task set state = ${state} where task_id = ${taskId}`;

export async function push(conn: Connection, sha: string): Promise<void> {
  await conn.db.appendEvent({
    type: "push",
    ts: new Date(),
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: { sha },
    source: { kind: "command", verb: "test" },
  });
}

/**
 * A Run of mergeProcess whose implement and review are done and whose merge
 * Task task_m waits ready for its keeper on oldHead.
 */
export async function mergeRun(
  conn: Connection,
  { withPr = false, rework = 3 } = {},
): Promise<void> {
  await clearDb(conn);
  await activeRevision(conn.db, "policy", "default", {
    gates: mergeGates,
    principals: mergePrincipals,
  });
  await activeRevision(conn.db, "crew", "default", crewValue);
  await activeRevision(
    conn.db,
    "process",
    "merge",
    mergeProcess(withPr, rework),
  );
  const { orca, log } = replay(conn, [
    ok("run-create", { run: { id: "run_1" } }),
    created("task_i"),
    created("task_r"),
    ...(withPr ? [created("task_p")] : []),
    created("task_m"),
    created("task_l"),
  ]);
  const made = await runCreate(conn.db, orca, null, log, {
    story: "S-1",
    process: { name: "merge", rev: 1 },
    size: "s",
    stage: "impl",
    coordinator: "session-1",
    host: "local",
    provider: "linear",
    command: "pod run create story:S-1",
    now: () => new Date(),
  });
  if (!made.ok) throw new Error(made.refusal.message);
  await setState(conn, "task_i", "done");
  await setState(conn, "task_r", "done");
  if (withPr) await setState(conn, "task_p", "done");
  await setState(conn, "task_m", "ready");
  await push(conn, oldHead);
}

export const created = (id: string) =>
  ok("task-create", { task: { id, status: "pending" } });

export const settledFail = (taskId: string) =>
  ok("task-update", {}, [
    "--id",
    taskId,
    "--status",
    "completed",
    "--result",
    "merge FAIL",
  ]);

export const settledPass = (taskId: string) =>
  ok("task-update", {}, ["--id", taskId, "--status", "completed"]);

export function keeperSays(tracker: FakeTracker, body: string): string {
  const id = `c-${tracker.comments.length + 1}`;
  tracker.comments.unshift({
    ref: { provider: "linear", external_id: "S-1", comment_id: id },
    authorId: "keeper-1",
    body,
    editedAt: null,
  });
  return id;
}

export function recordKeeper(
  conn: Connection,
  tracker: FakeTracker,
  orca: OrcaPort = noCalls(),
) {
  const bypassPath = join(
    mkdtempSync(join(tmpdir(), "pod-merge-")),
    "bypass.jsonl",
  );
  writeFileSync(
    bypassPath,
    `${JSON.stringify({ host: "h1", result: "pass", at: "2026-11-27T00:00:00.000Z" })}\n`,
  );
  return recordHqa(conn.db, orca, tracker, receiptLog(conn.db, "local"), {
    story: { provider: "linear", external_id: "S-1" },
    generation: 1,
    host: "local",
    hostName: "h1",
    bypassPath,
    principal: "human",
    command: "pod hqa record story:S-1 --generation 1",
    now: () => new Date(),
  });
}

/** The keeper FAILs task_m; the rework creates task_i2, task_r2, task_m2. */
export async function failMerge(
  conn: Connection,
  tracker: FakeTracker,
): Promise<void> {
  keeperSays(tracker, "merge FAIL");
  const { orca } = replay(conn, [
    settledFail("task_m"),
    created("task_i2"),
    created("task_r2"),
    created("task_m2"),
  ] satisfies TempEntry[]);
  const recorded = await recordKeeper(conn, tracker, orca);
  if (!recorded.ok) throw new Error(recorded.refusal.message);
  orca.assertDone();
}

/** The rework implement pushes newHead and its review PASSes. */
export async function passReworkReview(conn: Connection): Promise<void> {
  await setState(conn, "task_i2", "done");
  await setState(conn, "task_r2", "delivered");
  await push(conn, newHead);
  const passed = await applyOutcome(
    conn.db,
    noCalls(),
    receiptLog(conn.db, "local"),
    {
      task: "task_r2",
      outcome: "PASS",
      at: new Date(),
      host: "local",
      source: { kind: "command", verb: "test" },
      command: "pod verdict post",
      now: () => new Date(),
    },
  );
  if (!passed.ok) throw new Error(passed.refusal.message);
}
