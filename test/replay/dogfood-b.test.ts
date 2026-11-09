import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { BriefOutput } from "../../src/cli/brief.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, resume } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { singleActive } from "../../src/core/config/active.ts";
import { decisionLimits } from "../../src/core/config/limits.ts";
import { openDecision } from "../../src/core/decide/open.ts";
import { recordDeploy } from "../../src/core/deploy/record.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { postVerdict, VerdictFile } from "../../src/core/gate/verdict.ts";
import type {
  TrackerComment,
  TrackerPort,
} from "../../src/core/ports/tracker.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { events } from "../db/run-fixture.ts";

const dir = "test/replay/dogfood-b";
const orcaDir = "fixtures/orca/dogfood-b";
const trackerDir = "fixtures/tracker/dogfood-b";
const host = "local";
const story = "TRK-1";
const liveKey = "TPC-1413";
const candidate = "0cbc3ee2bca8c5da657ee80ff746674c9280b02e";
const merged = "ff0fe227b83a2d37b50b398d9e3aed17075fc27c";
const keeper = "00000000-0000-4000-8000-000000000014";
const start = Date.parse("2026-11-08T22:26:27.000Z");

describeDb("dogfood-b", () => {
  let conn: Connection;
  let tick = 0;
  const now = () => new Date(start + 1000 * tick++);
  const bypassPath = join(
    mkdtempSync(join(tmpdir(), "pod-dogfood-b-bypass-")),
    "bypass.jsonl",
  );

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    writeFileSync(
      bypassPath,
      `${JSON.stringify({ host, result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
    for (const file of [
      `${dir}/policy.yaml`,
      `${dir}/crew.yaml`,
      `${dir}/process.yaml`,
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

  test("the recorded xl Run replays through the hqa_after_deploy receipt and its measurement", async () => {
    const log = receiptLog(conn.db, host);
    const orca = makeReplayOrca({ dir: orcaDir, sink: log.sink });
    const recorded = makeReplayTracker({
      dir: trackerDir,
      sink: log.trackerSink,
      estimateScale: "fibonacci",
    });
    // The recorder rewrote the Story key inside comment bodies, but the
    // outbox and receipt hashes were taken over the bodies as posted.
    const posted = (comment: TrackerComment): TrackerComment => ({
      ...comment,
      body: comment.body.replaceAll(story, liveKey),
    });
    const tracker: TrackerPort = {
      ...recorded,
      readComment: async (ref) => {
        const read = await recorded.readComment(ref);
        return read.result === null
          ? read
          : { ...read, result: posted(read.result) };
      },
      readback: async (ref) => {
        const read = await recorded.readback(ref);
        if (read.result === null) return read;
        return {
          ...read,
          result:
            read.result.kind === "story"
              ? { ...read.result, comments: read.result.comments.map(posted) }
              : { ...read.result, comment: posted(read.result.comment) },
        };
      },
    };
    const templates = await singleActive(conn.db, "decision", "global", "");

    const created = await runCreate(conn.db, orca, tracker, log, {
      story,
      process: null,
      size: "xl",
      stage: null,
      coordinator: "operator",
      host,
      provider: "linear",
      command: `pod run create story:${story} --size xl`,
      seats: { templates, capacity: 1 },
      now,
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id, tasks } = created.result;
    expect(created.result).toMatchObject({
      process: "process.impl-xlarge@1",
      state: "active",
    });
    const id = (step: string) =>
      tasks.find((task) => task.step_id === step)?.task_id ?? "";
    const state = async (step: string) =>
      (await conn.db.getTask(id(step)))?.state;

    const check = () =>
      checkPass(conn.db, orca, tracker, log, {
        run: run_id,
        generation: 1,
        host,
        capacity: 1,
        now,
        leaseSeconds: launchLeaseSeconds,
        hostName: host,
        bypassPath,
      });
    const checked = async () => {
      const result = await check();
      if (!result.ok) throw new Error(result.refusal.message);
      return result.result;
    };
    const launch = async (step: string, seat: string) => {
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
    const verdict = async (name: string) => {
      const file = VerdictFile.parse(
        parse(readFileSync(`${dir}/${name}`, "utf8")),
      );
      expect(file.head_sha).toBe(candidate);
      const posted = await postVerdict(conn.db, orca, log, {
        file,
        generation: 1,
        host,
        command: "pod verdict post",
        now,
      });
      if (!posted.ok) throw new Error(posted.refusal.message);
    };
    const hqa = async () => {
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
      return recorded.result;
    };

    // The decider Seat ran the Run's first check itself, and Orca refused it.
    const refused = await check().catch((error: unknown) => error);
    expect(JSON.stringify(refused)).toContain(
      "worker_cannot_coordinate_own_run",
    );

    await checked();
    await launch("plan", "planner");
    expect((await checked()).deliveries).toMatchObject([{ outcome: "done" }]);
    expect(await state("plan")).toBe("delivered");

    const opened = await openDecision(conn.db, orca, log, {
      task: id("plan"),
      category: "architecture_choice",
      effect: "accept_plan",
      question: "Should the plan Task of the Story pass as written?",
      options: [
        "accept the plan as written, D1 included",
        "accept the plan without D1, deriving a Run's project from the pinned Revision's scope",
        "send the plan back to the planner with the changes the audit lists",
      ],
      generation: 1,
      opKey: null,
      host,
      capacity: 1,
      templates,
      limits: decisionLimits,
      now,
    });
    if (!opened.ok) throw new Error(opened.refusal.message);
    await checked();
    await checked();
    expect(await state("plan")).toBe("done");
    expect(await state("implement")).toBe("ready");

    await launch("implement", "developer");
    await checked();
    await checked();
    await checked();
    expect(await state("implement")).toBe("done");
    expect(await events(conn, "push")).toMatchObject([
      { payload: { sha: candidate } },
    ]);

    await launch("review", "reviewer");
    await checked();
    expect(await state("review")).toBe("delivered");
    await verdict("review-verdict.yaml");
    await checked();
    expect(await state("integration_review")).toBe("ready");

    await launch("integration_review", "integrator");
    expect((await checked()).unknown_workers).toHaveLength(1);
    expect((await conn.db.getRun(run_id))?.state).toBe("hold");
    await resume(conn.db, {
      run: run_id,
      task: null,
      generation: 1,
      host,
      now,
    });
    expect(await state("integration_review")).toBe("delivered");
    await verdict("integration-verdict.yaml");

    await launch("pr", "developer");
    await checked();
    await checked();
    expect(await events(conn, "pr")).toMatchObject([
      { payload: { number: 41, head: candidate } },
    ]);
    expect(await state("merge")).toBe("ready");

    expect(await hqa()).toMatchObject({
      gate: "merge",
      outcome: { state: "done" },
    });

    const pending = runCli([
      "config",
      "apply",
      `${dir}/policy-project.yaml`,
      "--activate",
      "--scope",
      "project:dogfood",
      "--expected-revision",
      "none",
    ]);
    expect(pending.json.result).toMatchObject({
      activation: null,
      pending: {
        profile: "hands-on",
        comment: "profile dogfood hands-on policy.dogfood-b-project@1",
      },
    });
    await checked();
    expect(await events(conn, "activation")).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ name: "dogfood-b-project" }),
      }),
    );

    const deployed = await recordDeploy(conn.db, {
      story: { provider: "linear", external_id: story },
      generation: 1,
      line: {
        environment: "local",
        deployment_id: "v0.1.1",
        deployed_revision: merged,
        source_commit: merged,
      },
      host,
      treeOf: async (sha) =>
        sha === candidate || sha === merged ? "tree-of-the-merge" : null,
      now,
    });
    if (!deployed.ok) throw new Error(deployed.refusal.message);
    expect(await state("deploy")).toBe("done");
    expect(await state("hqa")).toBe("ready");

    expect(await hqa()).toMatchObject({
      gate: "hqa_after_deploy",
      receipt_id: null,
    });
    expect(await hqa()).toMatchObject({
      gate: "hqa_after_deploy",
      outcome: { state: "done" },
    });

    const receipts = await conn.db.listGateReceipts(run_id);
    expect(
      receipts.map((row) => [
        row.gate_id,
        row.outcome,
        row.keeper,
        row.candidate_sha,
        row.deployed_revision,
      ]),
    ).toEqual([
      ["review", "PASS", "reviewer", candidate, null],
      ["integration_review", "PASS", "integrator", candidate, null],
      ["merge", "PASS", "keeper", candidate, null],
      ["hqa_after_deploy", "PASS", "keeper", candidate, merged],
    ]);

    const brief = runCli(["brief", `story:${story}`]);
    expect(brief.status, brief.json.error?.message).toBe(0);
    const [run] = BriefOutput.parse(brief.json.result).stories[0]?.runs ?? [];
    const measurement = run?.measurement;
    const pair = measurement?.pair;
    if (!measurement || !pair?.auditor) throw new Error("no pair measured");
    for (const seat of [pair.decider, pair.auditor]) {
      expect(seat.prompt_bytes).toBeGreaterThan(0);
      expect(seat.cold_start_ms).toBeGreaterThan(0);
    }
    expect([pair.decider.seat, pair.auditor.seat]).toEqual([
      "decider",
      "auditor",
    ]);
    expect(measurement.decisions).toEqual([
      {
        decision_id: opened.result.decision_id,
        state: "agreed",
        reason: "agreed",
        effect: "accept_plan",
        outcome: "adopted",
      },
    ]);
    expect(measurement.escalations).toEqual({
      "policy-required": 0,
      disagreement: 0,
      "context-missing": 0,
      "runtime-failure": 0,
      worker: 0,
      sample: 1,
      target: 10,
    });
    const decisionSeats = [pair.decider.seat, pair.auditor.seat];
    for (const row of receipts) {
      expect(decisionSeats).not.toContain(row.keeper);
    }
    expect(
      (await conn.db.listGateReceipts(run_id)).find(
        (row) => row.gate_id === "hqa_after_deploy",
      )?.source,
    ).toMatchObject({ author_id: keeper });

    orca.assertDone();
    recorded.assertDone();
  }, 300_000);
});
