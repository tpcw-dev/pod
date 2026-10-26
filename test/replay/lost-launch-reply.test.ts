import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  dispatch,
  type DispatchInput,
} from "../../src/core/dispatch/dispatch.ts";
import { freeSlots, launchIntents } from "../../src/core/dispatch/quota.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/lost-launch-reply";

describeDb("lost-launch-reply", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/lost-launch-reply/${kind}.yaml`,
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

  test("the same op key after a lost launch reply stops with the reservation held and no second worker-start", async () => {
    const log = receiptLog(conn.db, "rec");
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const created = await runCreate(conn.db, orca, log, {
      story: "REC-1",
      process: { name: "lost-launch-reply", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "record",
      host: "rec",
      provider: "linear",
      command: "pod run create story:REC-1",
      now: () => new Date(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [task] = created.result.tasks;
    expect(task?.state).toBe("ready");
    const input: DispatchInput = {
      task: task?.task_id ?? "",
      seat: "rec-dev",
      generation: 1,
      opKey: "rec-1",
      host: "rec",
      capacity: 2,
      command: (opKey) => `pod dispatch --op-key ${opKey}`,
      now: () => new Date(),
    };
    const first = await dispatch(conn.db, orca, log, input);
    expect(first).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    const second = await dispatch(conn.db, orca, log, input);
    expect(second).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        nextSteps: ["pod dispatch --op-key rec-1", "pod check"],
      },
    });
    orca.assertDone();
    expect(verbs).toEqual(["run-create", "task-create", "worker-start"]);
    expect(verbs.filter((verb) => verb === "worker-start")).toHaveLength(1);
    const reservations = await conn.db.launchReservations(launchIntents);
    expect(reservations).toEqual([
      { op_key: "rec-1", intent: "dispatch", status: "unknown" },
    ]);
    expect(
      freeSlots(2, await conn.db.hostActivities("rec"), reservations),
    ).toBe(1);
    expect((await conn.db.getTask(input.task))?.state).toBe("hold");
  });
});
