import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { release } from "../../src/core/dispatch/release.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { takeover } from "../../src/core/run/takeover.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/two-coordinator-handoff";
const oldHandle = "term_138f909e-aaa2-496c-97ea-796ec49e4fb8";
const newHandle = "term_0db4b199-e75e-4484-81b4-7487524ec679";
const scenario = "two-coordinator-handoff";

describeDb(scenario, () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/${scenario}/${kind}.yaml`,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, kind).toBe(0);
    }
  });
  afterAll(() => conn.close());

  test("after the takeover the old coordinator's dispatch, check, and release are refused before the side effect, and the new coordinator's check records the old Dispatch's delivery", async () => {
    const log = receiptLog(conn.db, "rec");
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const now = () => new Date();
    const created = await runCreate(conn.db, orca, log, {
      story: "REC-H",
      process: { name: scenario, rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: oldHandle,
      host: "rec",
      provider: "linear",
      command: "pod run create story:REC-H",
      now,
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const [t1, t2] = created.result.tasks.map((task) => task.task_id);
    const dispatchAs = (task: string, seat: string) =>
      dispatch(conn.db, orca, log, {
        task,
        seat,
        generation: 1,
        opKey: null,
        host: "rec",
        capacity: 2,
        command: (key) => `pod dispatch --op-key ${key}`,
        now,
      });
    const first = await dispatchAs(t1 ?? "", "rec-a");
    if (!first.ok) throw new Error(first.refusal.message);

    const views = mkdtempSync(join(tmpdir(), "pod-handoff-"));
    const taken = await takeover(conn.db, orca, log, {
      story: "REC-H",
      provider: "linear",
      generation: 1,
      coordinator: newHandle,
      opKey: null,
      viewPath: (runId, generation) =>
        join(views, `${runId}-${generation}.html`),
      host: "rec",
      command: (key) => `pod takeover story:REC-H --op-key ${key}`,
      now,
    });
    expect(taken).toMatchObject({
      ok: true,
      result: {
        run_id,
        owner_generation: 2,
        coordinator: newHandle,
        previous_coordinator: oldHandle,
        consumer_generation: 2,
        nextSteps: [`pod check --run ${run_id} --generation 2`],
      },
    });
    if (!taken.ok) return;
    expect(taken.result.restore_view).toContain("owner generation 2");
    expect(taken.result.restore_view).toContain(first.result.dispatch_id);
    const afterRunUse = verbs.length;

    const stale = { ok: false, refusal: { code: "owner_generation_stale" } };
    expect(await dispatchAs(t2 ?? "", "rec-b")).toMatchObject(stale);
    expect(
      await checkPass(conn.db, orca, log, {
        run: run_id,
        generation: 1,
        host: "rec",
        capacity: 2,
        now,
      }),
    ).toMatchObject(stale);
    expect(
      await release(conn.db, orca, log, {
        dispatch: first.result.dispatch_id,
        generation: 1,
        retain: null,
        host: "rec",
        now,
      }),
    ).toMatchObject(stale);
    expect(verbs.length).toBe(afterRunUse);

    const checked = await checkPass(conn.db, orca, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      now,
    });
    expect(checked).toMatchObject({
      ok: true,
      result: {
        deliveries: [
          { dispatch_id: first.result.dispatch_id, outcome: "done" },
        ],
        ignored: 0,
      },
    });
    orca.assertDone();
    expect(verbs).toEqual([
      "run-create",
      "task-create",
      "task-create",
      "worker-start",
      "run-show",
      "terminal-show",
      "run-use",
      "check",
      "check",
      "worker-list",
    ]);
    const run = await conn.db.getRun(run_id);
    expect(run).toMatchObject({ owner_generation: 2, coordinator: newHandle });
    expect(await conn.db.getDispatch(first.result.dispatch_id)).toMatchObject({
      settlement: "done",
      activity: "settled",
    });
    expect((await conn.db.getTask(t1 ?? ""))?.state).toBe("delivered");
  });

  test.todo(
    "the old coordinator's verdict is refused before the side effect: S6's remainder of tech spec line 699",
  );
});
