import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import {
  retry,
  retryPlan,
  type RetryInput,
} from "../../src/core/dispatch/retry.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { fixtures } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import {
  batch,
  dispatched,
  empty,
  events,
  freshRun,
  message,
  replay,
  started,
  taskState,
  workers,
  worktreeId,
} from "./run-fixture.ts";

const gitStatus = "## main...origin/main\n M src/a.ts";
const retryArgv = [
  "--task",
  "task_b",
  "--run",
  "run_1",
  "--agent",
  "claude",
  "--model",
  "m-1",
  "--effort",
  "low",
  "--worktree",
  `id:${worktreeId}`,
  "--retry-of",
  "ctx_1",
];

describeDb("pod retry", () => {
  let conn: Connection;
  let firstKey: string;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    firstKey = await dispatched(conn, "ctx_1");
    await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'stopped', settled_at = now()
      where dispatch_id = 'ctx_1'`;
    await conn.sql`update ledger.task set state = 'blocked' where task_id = 'task_b'`;
  });
  afterAll(() => conn.close());

  function input(over: Partial<RetryInput> = {}): RetryInput {
    return {
      dispatch: "ctx_1",
      generation: 1,
      opKey: null,
      host: "local",
      capacity: 2,
      gitStatus,
      command: (opKey) => `pod retry --dispatch ctx_1 --op-key ${opKey}`,
      now: () => new Date(),
      ...over,
    };
  }

  async function run(
    entries: readonly TempEntry[],
    over: Partial<RetryInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await retry(conn.db, orca, log, input(over));
    orca.assertDone();
    return outcome;
  }

  async function refused(code: string, over: Partial<RetryInput> = {}) {
    const outcome = await retry(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      input(over),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code } });
    return outcome;
  }

  test("retry restarts the Task in D's worktree with --retry-of and records the child manifest", async () => {
    const outcome = await run([
      ok("worker-start", started("ctx_2"), retryArgv),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      opKey: expect.stringMatching(/^retry:/),
      result: { dispatch_id: "ctx_2", retry_of: "ctx_1", seat: "dev-1" },
    });
    if (!outcome.ok) return;
    expect(outcome.result.task_view.startsWith(gitStatus)).toBe(true);
    expect(await conn.db.getDispatch("ctx_2")).toMatchObject({
      retry_of: "ctx_1",
      settlement: "open",
      activity: "running",
      requested_launch: { worktree: `id:${worktreeId}` },
    });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
    const parent = (await conn.db.getDispatch("ctx_1"))?.manifest_id;
    const child = await conn.db.getManifest(outcome.result.manifest_id);
    expect(child).toMatchObject({ parent_id: parent });
    expect(child?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "git_status", excerpt: gitStatus }),
      ]),
    );
    expect((await events(conn, "start")).at(-1)).toMatchObject({
      dispatch_id: "ctx_2",
      payload: { retry_of: "ctx_1" },
    });
    expect(
      await retry(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        input({ opKey: outcome.opKey }),
      ),
    ).toEqual(outcome);
  });

  test("a late worker_done from the stopped Dispatch moves nothing after the retry", async () => {
    await run([ok("worker-start", started("ctx_2"), retryArgv)]);
    const { orca, log } = replay(conn, [
      ok(
        "check",
        batch("delivery_1", [
          message("msg_1", "worker_done", {
            dispatchId: "ctx_1",
            outcome: "succeeded",
          }),
          message("msg_2", "escalation", { dispatchId: "ctx_1" }),
          message("msg_3", "novel", { dispatchId: "ctx_1" }),
        ]),
      ),
      ok("check", empty("delivery_1")),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_2", workerState: "ready" }]),
      ),
    ]);
    await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
    });
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["settled_dispatch", "settled_dispatch", "settled_dispatch"]);
    expect(await taskState(conn, "task_b")).toBe("dispatched");
    expect(await conn.db.getDispatch("ctx_2")).toMatchObject({
      settlement: "open",
    });
  });

  test("placement fields missing from requested_launch come from the Seat", async () => {
    await conn.sql`
      update ledger.dispatch set requested_launch = ${JSON.stringify({ worktree: `id:${worktreeId}` })}::jsonb
      where dispatch_id = 'ctx_1'`;
    expect(
      await run([ok("worker-start", started("ctx_2"), retryArgv)]),
    ).toMatchObject({ ok: true });
  });

  test("each refusal, in order", async () => {
    const unknown = await refused("task_not_ready", { dispatch: "ctx_none" });
    expect(unknown).toMatchObject({
      refusal: { message: "no Dispatch ctx_none" },
    });

    await conn.sql`
      update ledger.dispatch set requested_launch = ${JSON.stringify({ model: "m-1", worktree: "current" })}::jsonb
      where dispatch_id = 'ctx_1'`;
    expect(await refused("task_not_ready")).toMatchObject({
      refusal: { message: "Dispatch ctx_1 has no recorded worktree" },
    });
    await conn.sql`
      update ledger.dispatch set requested_launch = ${JSON.stringify({ worktree: `id:${worktreeId}` })}::jsonb
      where dispatch_id = 'ctx_1'`;
    expect(
      await refused("task_not_ready", { host: "elsewhere" }),
    ).toMatchObject({
      refusal: {
        message: "Dispatch ctx_1 started on host local, not elsewhere",
      },
    });
    expect(
      await conn.sql`select 1 from ledger.operation where intent = 'retry'`,
    ).toHaveLength(0);

    await refused("owner_generation_stale", {
      generation: 2,
      opKey: "k-stale",
    });
    await conn.sql`update ledger.task set state = 'dispatched'`;
    await refused("task_not_ready", { opKey: "k-state" });
    await conn.sql`update ledger.task set state = 'blocked' where task_id = 'task_b'`;
    await conn.sql`update ledger.dispatch set created_at = now() - interval '1 hour' where dispatch_id = 'ctx_1'`;
    await conn.sql`
      insert into ledger.dispatch (dispatch_id, task_id, run_id, seat, role, requested_launch, model_attribution,
        op_key, settlement, created_at, activity)
      values ('ctx_later', 'task_b', 'run_1', 'dev-1', 'developer', '{}', 'unknown', ${firstKey}, 'stopped', now(), 'settled')`;
    expect(
      await refused("task_not_ready", { opKey: "k-latest" }),
    ).toMatchObject({
      refusal: {
        nextSteps: expect.arrayContaining([
          "Dispatch ctx_1 is not the Task's latest Dispatch",
        ]),
      },
    });
    await conn.sql`delete from ledger.dispatch where dispatch_id = 'ctx_later'`;
    await conn.db.appendEvent({
      type: "drain",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { ended: false, op_key: "k-drain-event" },
      source: { kind: "command", verb: "drain" },
    });
    await refused("drained", { opKey: "k-drain" });
    await conn.db.appendEvent({
      type: "drain",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { ended: true, op_key: "k-end-event" },
      source: { kind: "command", verb: "drain" },
    });
    await refused("quota_exhausted", { capacity: 0, opKey: "k-quota" });
    await conn.db.insertOperation({
      op_key: "in-flight",
      intent: "dispatch",
      owner_generation: 1,
      at: new Date(),
      result_ref: {
        request: { task_id: "task_b", seat: "dev-1", host: "local" },
      },
    });
    await refused("task_not_ready", { opKey: "k-flight" });
    const rows = await conn.sql<{ op_key: string; status: string }[]>`
      select op_key, status from ledger.operation where intent = 'retry' order by op_key`;
    expect(rows.every((row) => row.status === "refused")).toBe(true);
    expect(rows).toHaveLength(6);
    await refused("duplicate_op", { opKey: firstKey });
  });

  test("a failed start leaves the Task blocked; an unknown one holds it", async () => {
    const failed = await run([
      {
        verb: "worker-start",
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "task_not_startable", message: "no" },
        }),
      },
    ]);
    expect(failed).toMatchObject({ ok: false, refusal: { code: "failed" } });
    expect(await taskState(conn, "task_b")).toBe("blocked");
    const unknown = await run(
      [unknownReply("worker-start", "66666666-6666-4666-8666-666666666666")],
      { opKey: "k-unknown" },
    );
    expect(unknown).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    expect(await taskState(conn, "task_b")).toBe("hold");
    expect((await events(conn, "hold")).at(-1)?.payload).toMatchObject({
      reason: "launch_unknown",
      from: "blocked",
    });
    expect((await conn.db.getOperation("k-unknown"))?.status).toBe("unknown");
  });

  test("a retry of a retried Dispatch shows only the newest git status", async () => {
    const first = await run([ok("worker-start", started("ctx_2"), retryArgv)]);
    expect(first.ok).toBe(true);
    await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'stopped', settled_at = now()
      where dispatch_id = 'ctx_2'`;
    await conn.sql`update ledger.task set state = 'blocked' where task_id = 'task_b'`;
    const newer = "## main...origin/main\n M src/b.ts";
    const second = await run(
      [
        ok("worker-start", started("ctx_3"), [
          ...retryArgv.slice(0, -1),
          "ctx_2",
        ]),
      ],
      { dispatch: "ctx_2", gitStatus: newer },
    );
    if (!second.ok) throw new Error(second.refusal.message);
    expect(second.result.task_view.startsWith(newer)).toBe(true);
    expect(second.result.task_view).not.toContain("src/a.ts");
    const manifest = await conn.db.getManifest(second.result.manifest_id);
    expect(
      z
        .array(z.looseObject({ source: z.string(), excerpt: z.string() }))
        .parse(manifest?.references)
        .filter((row) => row.source === "git_status")
        .map((row) => row.excerpt),
    ).toEqual([newer]);
  });

  test("retryPlan returns the path after the first ::", async () => {
    await conn.sql`
      update ledger.dispatch set requested_launch = ${JSON.stringify({ worktree: "id:repo::/w/a::b" })}::jsonb
      where dispatch_id = 'ctx_1'`;
    expect(await retryPlan(conn.db, "ctx_1", "local")).toEqual({
      worktreePath: "/w/a::b",
    });
  });

  test("the CLI reads git status in D's worktree, and a missing worktree fails before any operation", async () => {
    const args = ["retry", "--dispatch", "ctx_1", "--generation", "1"];
    const missing = runCli(args);
    expect(missing.status).toBe(1);
    expect(missing.json.error?.message).toContain(
      "git status in /w/one failed",
    );
    expect(
      await conn.sql`select 1 from ledger.operation where intent = 'retry'`,
    ).toHaveLength(0);
    const here = `repo-1::${process.cwd()}`;
    await conn.sql`
      update ledger.dispatch set requested_launch = ${JSON.stringify({ worktree: `id:${here}` })}::jsonb
      where dispatch_id = 'ctx_1'`;
    const done = runCli(args, {
      POD_ORCA_FIXTURES: fixtures([
        ok("worker-start", started("ctx_2"), [
          "--worktree",
          `id:${here}`,
          "--retry-of",
          "ctx_1",
        ]),
      ]),
    });
    expect(done.status).toBe(0);
    expect(done.json).toMatchObject({
      result: { dispatch_id: "ctx_2", retry_of: "ctx_1" },
      meta: { ownerGeneration: 1, opKey: expect.stringMatching(/^retry:/) },
    });
    expect(String(done.json.result?.["task_view"])).toMatch(/^## /);
  });
});
