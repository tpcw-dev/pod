import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { orcaFor } from "../../src/cli/orca.ts";
import { trackerFor } from "../../src/cli/tracker.ts";
import { checkWait, type WaitInput } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { decisionLimits } from "../../src/core/config/limits.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const orcaDir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/decision-fallback";
const trackerDir =
  process.env["POD_TRACKER_FIXTURES"] ?? "fixtures/tracker/decision-fallback";
const recording = (process.env["POD_ORCA_RECORD"] ?? "") !== "";
const story = recording ? (process.env["POD_TRACKER_STORY"] ?? "") : "TRK-1";
const question =
  "Which rollout should the plan use? The plan must name a rollback step before it can be agreed. The decider proposes the option that names a rollback step, and the auditor agrees with a proposal that names one.";
const options = [
  "ship everything in one release",
  "ship in two releases with a rollback step between them",
];

function stopWorker(dispatchId: string): void {
  spawnSync(
    "orca",
    ["orchestration", "worker-stop", "--dispatch", dispatchId, "--json"],
    { encoding: "utf8", timeout: 60_000 },
  );
}

describeDb("decision-fallback", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const file of [
      "test/replay/decision-fallback/policy.yaml",
      "test/replay/decision-fallback/crew.yaml",
      "test/replay/decision-fallback/process.yaml",
      "specs/decision/default.yaml",
    ]) {
      const applied = runCli([
        "config",
        "apply",
        file,
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
    "a refused decider launch opens the fallback Seat and the Decision still agrees",
    async () => {
      if (recording && story === "")
        throw new Error("recording needs POD_TRACKER_STORY");
      const log = receiptLog(conn.db, "rec");
      const orcaWired = recording ? orcaFor(log.sink, "rec") : null;
      const orcaReplay = recording
        ? null
        : makeReplayOrca({ dir: orcaDir, sink: log.sink });
      const chosen = orcaWired?.port ?? orcaReplay;
      if (chosen === null) throw new Error("no Orca port");
      const orca: OrcaPort = chosen;
      const trackerWired = recording
        ? await trackerFor(log.trackerSink, {
            hostId: "rec",
            urlEnv: "POD_DB_URL",
            capacity: 2,
            trackerKind: "linear",
            trackerTokenEnv: "POD_TRACKER_TOKEN",
            estimateScale: "fibonacci",
            docsKind: "notion",
            docsTokenEnv: "POD_DOCS_TOKEN",
          })
        : null;
      const trackerReplay = recording
        ? null
        : makeReplayTracker({
            dir: trackerDir,
            sink: log.trackerSink,
            estimateScale: "fibonacci",
          });
      const tracker: TrackerPort | null = trackerWired?.port ?? trackerReplay;
      const now = () => new Date();
      const created = await runCreate(conn.db, orca, tracker, log, {
        story,
        process: { name: "decision-fallback", rev: 1 },
        size: "xl",
        stage: "impl",
        coordinator: "record",
        host: "rec",
        provider: "linear",
        command: `pod run create story:${story}`,
        now,
      });
      if (!created.ok) throw new Error(created.refusal.message);
      const { run_id } = created.result;
      const plan = created.result.tasks.find((row) => row.step_id === "plan");
      if (plan === undefined) throw new Error("the Run has no plan Task");
      const stops: string[] = [];
      try {
        const started = await dispatch(conn.db, orca, log, {
          task: plan.task_id,
          seat: "rec-plan",
          generation: 1,
          opKey: null,
          host: "rec",
          capacity: 1,
          command: (opKey) => `pod dispatch --op-key ${opKey}`,
          now,
        });
        if (!started.ok) throw new Error(started.refusal.message);
        stops.push(started.result.dispatch_id);
        const wait = (decision: string | null): WaitInput => ({
          run: run_id,
          generation: 1,
          host: "rec",
          capacity: 1,
          leaseSeconds: launchLeaseSeconds,
          now,
          decision,
          interval: recording ? 20 : 0,
          timeout: recording ? 1500 : 3600,
          sleep: (seconds) =>
            new Promise((done) => setTimeout(done, seconds * 1000)),
        });
        for (;;) {
          const delivered = await checkWait(
            conn.db,
            orca,
            tracker,
            log,
            wait(null),
          );
          if (!delivered.ok) throw new Error(delivered.refusal.message);
          if ((await conn.db.getTask(plan.task_id))?.state === "delivered")
            break;
        }
        const decided = await openDecision(conn.db, orca, log, {
          task: plan.task_id,
          category: "architecture_choice",
          effect: "accept_plan",
          question,
          options,
          generation: 1,
          opKey: null,
          host: "rec",
          capacity: 1,
          templates: await conn.db.getRevisionByRef("decision", "default", 1),
          limits: decisionLimits,
          now,
        });
        if (!decided.ok) throw new Error(decided.refusal.message);
        const id = decided.result.decision_id;
        stops.push(decided.result.decider_dispatch_id);
        const settled = await checkWait(conn.db, orca, tracker, log, wait(id));
        for (const row of await conn.db.listDispatches(run_id))
          if (!stops.includes(row.dispatch_id)) stops.push(row.dispatch_id);
        if (!settled.ok) throw new Error(settled.refusal.message);

        const decider = await conn.db.getDispatch(
          decided.result.decider_dispatch_id,
        );
        expect(decider).toMatchObject({
          seat: "rec-decider-fallback",
          role: "decider",
          requested_launch: { agent: "claude", model: "claude-sonnet-5" },
        });
        const starts = await conn.sql<
          { dispatch_id: string; payload: Record<string, unknown> }[]
        >`select dispatch_id, payload from ledger.event where type = 'start' order by id`;
        expect(
          starts.find((row) => row.dispatch_id === decider?.dispatch_id)
            ?.payload,
        ).toMatchObject({ fallback_of: "rec-decider" });
        const seatOps = await conn.sql<
          { status: string; seat: string; fallback_of: string | null }[]
        >`select status, result_ref -> 'request' ->> 'seat' as seat,
            result_ref -> 'request' ->> 'fallback_of' as fallback_of
          from ledger.operation where intent = 'decide_seat' order by created_at`;
        expect(seatOps).toEqual([
          { status: "refused", seat: "rec-decider", fallback_of: null },
          {
            status: "done",
            seat: "rec-decider-fallback",
            fallback_of: "rec-decider",
          },
          { status: "done", seat: "rec-auditor", fallback_of: null },
        ]);
        const auditors = await conn.sql<{ dispatch_id: string }[]>`
          select dispatch_id from ledger.dispatch where role = 'auditor'`;
        expect(auditors).toHaveLength(1);
        expect(
          starts.find((row) => row.dispatch_id === auditors[0]?.dispatch_id)
            ?.payload,
        ).not.toHaveProperty("fallback_of");
        expect((await conn.db.getDecision(id))?.state).toBe("agreed");

        const brief = runCli(["brief", `story:${story}`]);
        expect(brief.status).toBe(0);
        expect(brief.json.result).toMatchObject({
          stories: [{ counters: { fallback_launches: 1 } }],
        });
      } finally {
        if (recording) for (const id of stops) stopWorker(id);
      }
      const refused = [
        ...(orcaWired?.recordRefusals() ?? []),
        ...(trackerWired?.recordRefusals() ?? []),
      ];
      if (refused.length > 0)
        throw new Error(
          `${refused.map((item) => item.file).join(", ")} matched the denylist`,
        );
      orcaReplay?.assertDone();
      trackerReplay?.assertDone();
    },
    recording ? 1_800_000 : 60_000,
  );
});
