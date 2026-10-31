import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeRealOrca } from "../../src/adapters/orca/real.ts";
import { makeScrubber } from "../../src/adapters/orca/scrub.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const replayDir = "fixtures/orca/direct-launch";
const trackerDir = "fixtures/tracker/direct-launch";
const recordDir = process.env["POD_ORCA_RECORD"] ?? "";
const recording = recordDir !== "";
const story = "DL-1";
const seat = "rec-dev";
const foreignSpec = "Reply DONE and exit at once. Do not edit any file.";

const Started = z.looseObject({
  result: z.looseObject({ dispatchId: z.string().optional() }).optional(),
});

function orcaCli(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("orca", args, {
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function startForeign(runId: string): string {
  const started = orcaCli([
    "orchestration",
    "worker-start",
    "--spec",
    foreignSpec,
    "--run",
    runId,
    "--agent",
    "claude",
    "--model",
    "claude-haiku-4-5-20251001",
    "--effort",
    "low",
    "--worktree",
    "new-child",
    "--name",
    "drill-foreign",
    "--setup",
    "skip",
    "--json",
  ]);
  const parsed = Started.safeParse(JSON.parse(started.stdout || "{}"));
  const dispatchId = parsed.success ? parsed.data.result?.dispatchId : undefined;
  if (started.status !== 0 || dispatchId === undefined) {
    const detail = z
      .looseObject({
        error: z.looseObject({
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      })
      .safeParse(parsed.success ? parsed.data : {});
    const code = detail.success ? detail.data.error?.code : undefined;
    const message = detail.success ? detail.data.error?.message : undefined;
    throw new Error(
      `foreign worker-start exited ${started.status ?? "null"}: ${code ?? "unreadable"} ${message ?? ""}`.trim(),
    );
  }
  return dispatchId;
}

function stopWorker(dispatchId: string): void {
  orcaCli([
    "orchestration",
    "worker-stop",
    "--dispatch",
    dispatchId,
    "--json",
  ]);
}

function removeWorktree(selector: string): void {
  const removed = orcaCli(["worktree", "rm", "--worktree", selector, "--json"]);
  if (removed.status !== 0)
    throw new Error(`worktree rm exited ${removed.status ?? "null"}`);
}

describeDb("direct-launch", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const file of ["policy.yaml", "crew.yaml", "process.yaml"]) {
      const applied = runCli([
        "config",
        "apply",
        `test/drill/direct-launch/${file}`,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, applied.json.error?.message ?? file).toBe(0);
    }
  });
  afterAll(() => conn.close());

  test(
    "a worker the ledger does not know holds the run",
    async () => {
      const log = receiptLog(conn.db, "rec");
      const deny = process.env["POD_SCRUB_DENYLIST"] ?? "";
      if (recording && deny === "")
        throw new Error("recording needs POD_SCRUB_DENYLIST");
      if (recording) {
        rmSync(recordDir, { recursive: true, force: true });
        mkdirSync(recordDir, { recursive: true });
      }
      const recorded = recording
        ? makeRealOrca({
            sink: log.sink,
            record: {
              dir: recordDir,
              kill: null,
              scrubber: makeScrubber({
                hosts: [hostname(), "rec"],
                users: [userInfo().username],
                roots: [process.cwd()],
                denylist: readFileSync(deny, "utf8").split("\n"),
              }),
            },
          })
        : null;
      const replay = recording
        ? null
        : makeReplayOrca({ dir: replayDir, sink: log.sink });
      const chosen = recorded ?? replay;
      if (chosen === null) throw new Error("no Orca port");
      const orca: OrcaPort = chosen;
      const tracker = makeReplayTracker({
        dir: trackerDir,
        sink: log.trackerSink,
        estimateScale: "fibonacci",
      });
      const now = () => new Date();
      const created = await runCreate(conn.db, orca, null, log, {
        story,
        process: { name: "direct-launch", rev: 1 },
        size: "s",
        stage: "impl",
        coordinator: "record",
        host: "rec",
        provider: "linear",
        command: `pod run create story:${story}`,
        now,
      });
      if (!created.ok) throw new Error(created.refusal.message);
      const { run_id } = created.result;
      const task = created.result.tasks[0]?.task_id ?? "";
      const started = await dispatch(conn.db, orca, log, {
        task,
        seat,
        generation: 1,
        opKey: null,
        host: "rec",
        capacity: 2,
        command: (opKey) => `pod dispatch --op-key ${opKey}`,
        now,
      });
      if (!started.ok) throw new Error(started.refusal.message);
      const stopIds = [started.result.dispatch_id];
      try {
        if (recording) {
          stopIds.push(startForeign(run_id));
        }
        const check = {
          run: run_id,
          generation: 1,
          host: "rec",
          capacity: 2,
          leaseSeconds: launchLeaseSeconds,
          now,
        };
        const first = await checkPass(conn.db, orca, null, log, check);
        if (!first.ok) throw new Error(first.refusal.message);
        const unknown = await conn.sql<{ dispatch_id: string }[]>`
          select dispatch_id from ledger.event where type = 'unknown_launch'`;
        expect(unknown).toHaveLength(1);
        expect(unknown[0]?.dispatch_id).not.toBe(started.result.dispatch_id);
        expect(
          await conn.sql<{ reason: string | null }[]>`
            select payload->>'reason' as reason from ledger.event
            where type = 'hold' and task_id is null`,
        ).toEqual([{ reason: "unknown_launch" }]);
        expect((await conn.db.getRun(run_id))?.state).toBe("hold");
        for (const row of await conn.db.listTasks(run_id)) {
          if (row.state === "done" || row.state === "failed") continue;
          expect(row.state, row.task_id).toBe("hold");
        }
        const again = await checkPass(conn.db, orca, null, log, check);
        if (!again.ok) throw new Error(again.refusal.message);
        expect(
          await conn.sql<{ n: number }[]>`
            select count(*)::int as n from ledger.event where type = 'unknown_launch'`,
        ).toEqual([{ n: 1 }]);
        const refused = await dispatch(conn.db, orca, log, {
          task,
          seat,
          generation: 1,
          opKey: "direct-launch-again",
          host: "rec",
          capacity: 2,
          command: (opKey) => `pod dispatch --op-key ${opKey}`,
          now,
        });
        expect(refused.ok).toBe(false);
        expect((await conn.db.getRun(run_id))?.state).toBe("hold");
      } finally {
        if (recording) {
          for (const id of stopIds) stopWorker(id);
          removeWorktree("name:drill-foreign");
        }
      }
      const refusedRecord = recorded?.recordRefusals() ?? [];
      if (refusedRecord.length > 0)
        throw new Error(
          refusedRecord.map((item) => item.file).join(", ") + " matched the denylist",
        );
      if (replay !== null) {
        replay.assertDone();
        tracker.assertDone();
      }
    },
    recording ? 300_000 : 30_000,
  );
});
