import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { applyOutcome } from "../../src/core/process/project.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/integration-review";
const host = "podrec";

describeDb("integration-review", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/integration-review/${kind}.yaml`,
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

  test("review waits for both implement Tasks, and pr waits for the review PASS", async () => {
    const log = receiptLog(conn.db, host);
    const orca = makeReplayOrca({ dir, sink: log.sink });
    const created = await runCreate(conn.db, orca, log, {
      story: "S5B-13",
      process: { name: "integration-review", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "record",
      host,
      provider: "linear",
      command: "pod run create story:S5B-13",
      now: () => new Date(),
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id } = created.result;
    const ids = new Map(
      created.result.tasks.map((task) => [task.step_id, task.task_id]),
    );
    const id = (step: string) => ids.get(step) ?? "";
    const state = async (step: string) =>
      (await conn.db.getTask(id(step)))?.state;
    const start = async (step: string, seat: string) => {
      const started = await dispatch(conn.db, orca, log, {
        task: id(step),
        seat,
        generation: 1,
        opKey: null,
        host,
        capacity: 1,
        command: (key) => `pod dispatch --op-key ${key}`,
        now: () => new Date(),
      });
      expect(started, step).toMatchObject({ ok: true });
    };
    const check = async () => {
      const checked = await checkPass(conn.db, orca, log, {
        run: run_id,
        generation: 1,
        host,
        capacity: 1,
        leaseSeconds: launchLeaseSeconds,
        now: () => new Date(),
      });
      expect(checked).toMatchObject({
        ok: true,
        result: { deliveries: [{ outcome: "done" }] },
      });
    };

    expect(await state("implement-a")).toBe("ready");
    expect(await state("implement-b")).toBe("ready");
    await start("implement-a", "rec-dev");
    await check();
    expect(await state("implement-a")).toBe("done");
    expect(await state("review")).toBe("pending");
    expect(await state("pr")).toBe("pending");

    await start("implement-b", "rec-dev");
    await check();
    expect(await state("implement-b")).toBe("done");
    expect(await state("review")).toBe("ready");
    expect(await state("pr")).toBe("pending");

    await start("review", "rec-rev");
    await check();
    expect(await state("review")).toBe("delivered");
    expect(await state("pr")).toBe("pending");

    const passed = await applyOutcome(conn.db, orca, log, {
      task: id("review"),
      outcome: "PASS",
      at: new Date(),
      host,
      source: { kind: "command", verb: "test" },
      command: "pod verdict post",
      now: () => new Date(),
    });
    expect(passed).toMatchObject({
      ok: true,
      result: { state: "done", promoted: [id("pr")] },
    });
    expect(await state("pr")).toBe("ready");
    orca.assertDone();
  });
});
