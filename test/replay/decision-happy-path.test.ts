import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { makeRealOrca } from "../../src/adapters/orca/real.ts";
import { makeTrackerScrubber } from "../../src/adapters/linear/scrub.ts";
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
import { buildState } from "../../src/core/state/view.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const orcaDir =
  process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/decision-happy-path";
const trackerDir =
  process.env["POD_TRACKER_FIXTURES"] ?? "fixtures/tracker/decision-happy-path";
const recording = (process.env["POD_ORCA_RECORD"] ?? "") !== "";
const story = recording ? (process.env["POD_TRACKER_STORY"] ?? "") : "TRK-1";
const question =
  "Which rollout should the plan use? The plan must name a rollback step before it can be agreed. The auditor disagrees with any proposal that does not name a rollback step. The decider proposes the first option in round 1.";
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

describeDb("decision-happy-path", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const file of [
      "test/replay/decision-happy-path/policy.yaml",
      "test/replay/decision-happy-path/crew.yaml",
      "test/replay/decision-happy-path/process.yaml",
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
    "a two-round Decision agrees the plan in the same two Dispatches",
    async () => {
      if (recording && story === "")
        throw new Error("recording needs POD_TRACKER_STORY");
      const log = receiptLog(conn.db, "rec");
      if (recording)
        mkdirSync(process.env["POD_ORCA_RECORD"] ?? "", { recursive: true });
      const orcaWired = recording
        ? makeRealOrca({
            sink: log.sink,
            record: {
              dir: process.env["POD_ORCA_RECORD"] ?? "",
              kill: null,
              scrubber: makeTrackerScrubber({
                hosts: [hostname(), "rec"],
                users: [userInfo().username],
                roots: [process.cwd()],
                workspace: [],
                denylist: readFileSync(
                  process.env["POD_SCRUB_DENYLIST"] ?? "",
                  "utf8",
                ).split("\n"),
              }),
            },
          })
        : null;
      const orcaReplay = recording
        ? null
        : makeReplayOrca({ dir: orcaDir, sink: log.sink });
      const chosen = orcaWired ?? orcaReplay;
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
        process: { name: "decision-happy-path", rev: 1 },
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
      const implement = created.result.tasks.find(
        (row) => row.step_id === "implement",
      );
      if (plan === undefined || implement === undefined)
        throw new Error("the Run has no plan or implement Task");
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
        const templates = await conn.db.getRevisionByRef(
          "decision",
          "default",
          1,
        );
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
          templates,
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

        const seats = await conn.sql<
          {
            dispatch_id: string;
            role: string;
            task_id: string | null;
            decision_id: string | null;
          }[]
        >`select dispatch_id, role, task_id, decision_id from ledger.dispatch
          where role in ('decider', 'auditor') order by role desc`;
        expect(seats.map((row) => row.role)).toEqual(["decider", "auditor"]);
        for (const row of seats)
          expect(row).toMatchObject({ task_id: null, decision_id: id });
        const [deciderRow, auditorRow] = seats;
        const rounds = await conn.sql<
          {
            round: number;
            stance: string;
            decider_dispatch_id: string;
            auditor_dispatch_id: string;
          }[]
        >`select round, stance, decider_dispatch_id, auditor_dispatch_id
          from ledger.decision_round where decision_id = ${id} order by round`;
        expect(rounds).toEqual([
          {
            round: 1,
            stance: "disagree",
            decider_dispatch_id: deciderRow?.dispatch_id,
            auditor_dispatch_id: auditorRow?.dispatch_id,
          },
          {
            round: 2,
            stance: "agree",
            decider_dispatch_id: deciderRow?.dispatch_id,
            auditor_dispatch_id: auditorRow?.dispatch_id,
          },
        ]);
        const decision = await conn.db.getDecision(id);
        const events = await conn.sql<{ payload: Record<string, unknown> }[]>`
          select payload from ledger.event where type = 'decision'`;
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toMatchObject({
          decision_id: id,
          manifest_id: decision?.manifest_id,
          rounds: 2,
          outcome: "agreed",
        });
        expect((await conn.db.getTask(plan.task_id))?.state).toBe("done");
        expect((await conn.db.getTask(implement.task_id))?.state).toBe("ready");

        const built = await buildState(
          { repo: conn.db, docs: null, now },
          { story, project: null },
        );
        if (!built.ok) throw new Error(built.refusal.message);
        expect(built.view.decisions.decisions).toMatchObject([
          { id, standing: false, in_force_until: null },
        ]);
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
