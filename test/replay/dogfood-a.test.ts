import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { countRun } from "../../src/core/brief/counters.ts";
import { checkWait } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { EventType } from "../../src/core/domain/ledger.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { postVerdict } from "../../src/core/gate/verdict.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { events } from "../db/run-fixture.ts";

const orcaDir = "fixtures/orca/dogfood-a";
const trackerDir = "fixtures/tracker/dogfood-a";
const host = "rec";
const story = "TRK-1";
const head = "3be3115f623a06e7e17c5e063a050d34e535e33e";
const now = () => new Date("2026-10-31T21:04:03.249Z");

describeDb("dogfood-a", () => {
  let conn: Connection;
  const bypassPath = join(
    mkdtempSync(join(tmpdir(), "pod-dogfood-bypass-")),
    "bypass.jsonl",
  );

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host, result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
    for (const kind of ["policy", "crew", "process"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/replay/dogfood-a/${kind}.yaml`,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, applied.json.error?.message ?? kind).toBe(0);
    }
  });
  afterAll(() => conn.close());

  test(
    "the recorded run replays through the merge receipt",
    async () => {
      const log = receiptLog(conn.db, host);
      const orca = makeReplayOrca({ dir: orcaDir, sink: log.sink });
      const tracker = makeReplayTracker({
        dir: trackerDir,
        sink: log.trackerSink,
        estimateScale: "fibonacci",
      });
      const created = await runCreate(conn.db, orca, tracker, log, {
        story,
        process: { name: "impl-small", rev: 1 },
        size: "xs",
        stage: "impl",
        coordinator: "record",
        host,
        provider: "linear",
        command: `pod run create story:${story}`,
        now,
      });
      if (!created.ok) throw new Error(created.refusal.message);
      const { run_id, tasks } = created.result;
      const id = (step: string) =>
        tasks.find((task) => task.step_id === step)?.task_id ?? "";
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
          now,
        });
        expect(started, step).toMatchObject({ ok: true });
      };
      const wait = async () => {
        const checked = await checkWait(conn.db, orca, tracker, log, {
          run: run_id,
          generation: 1,
          host,
          capacity: 1,
          leaseSeconds: launchLeaseSeconds,
          decision: null,
          interval: 1,
          timeout: 3600,
          sleep: async () => {},
          now,
        });
        if (!checked.ok) throw new Error(checked.refusal.message);
        expect(checked.result.deliveries).toMatchObject([{ outcome: "done" }]);
      };

      expect(await state("implement")).toBe("ready");
      await start("implement", "developer");
      await wait();
      expect(await state("implement")).toBe("done");
      expect(await state("review")).toBe("ready");

      await start("review", "reviewer");
      await wait();
      expect(await state("review")).toBe("delivered");

      const passed = await postVerdict(conn.db, orca, log, {
        file: {
          gate: "review",
          task: id("review"),
          head_sha: head,
          reviewer: "reviewer",
          outcome: "PASS",
        },
        generation: 1,
        host,
        command: "pod verdict post",
        now,
      });
      if (!passed.ok) throw new Error(passed.refusal.message);
      expect(await state("review")).toBe("done");
      expect(await state("pr")).toBe("ready");

      await start("pr", "developer");
      await wait();
      expect(await state("pr")).toBe("done");
      expect(await state("merge")).toBe("ready");

      const recorded = await recordHqa(conn.db, orca, tracker, log, {
        story: { provider: "linear", external_id: story },
        generation: 1,
        host,
        hostName: host,
        bypassPath,
        command: "pod hqa record",
        now,
      });
      if (!recorded.ok) throw new Error(recorded.refusal.message);
      expect(recorded.result).toMatchObject({
        gate: "merge",
        outcome: { state: "done" },
      });
      expect(await state("merge")).toBe("done");
      expect(await state("deploy")).toBe("ready");
      expect(await state("hqa")).toBe("pending");

      const receipts = await conn.db.listGateReceipts(run_id);
      expect(receipts.map((row) => [row.gate_id, row.outcome])).toEqual([
        ["review", "PASS"],
        ["merge", "PASS"],
      ]);
      expect(await events(conn, "push")).toHaveLength(2);
      expect(await events(conn, "pr")).toHaveLength(1);

      const runEvents = [
        ...(await conn.sql<
          {
            run_id: string | null;
            type: string;
            op_key: string | null;
            source: Json;
          }[]
        >`select run_id, type, op_key, source from ledger.event where run_id = ${run_id}`),
      ].map((row) => ({
        run_id: row.run_id,
        type: EventType.parse(row.type),
        op_key: row.op_key,
        source: row.source,
      }));
      const operations = [
        ...(await conn.sql<
          { op_key: string }[]
        >`select op_key from ledger.operation`),
      ];
      const counters = countRun(
        { run_id },
        await conn.db.listTasks(run_id),
        await conn.db.listDispatches(run_id),
        runEvents,
        operations,
      );
      expect(counters).toEqual({
        coordinator_operations: 11,
        recovery_steps: 0,
        retries: 0,
        rework_tasks: 0,
        hand_filled: 2,
      });
      orca.assertDone();
      tracker.assertDone();
    },
    180_000,
  );
});
