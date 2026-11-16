import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Kind } from "../../src/core/domain/config.ts";
import { Json } from "../../src/core/domain/json.ts";
import { TriggerSource } from "../../src/core/domain/tick.ts";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import { observedStates } from "../../src/core/operate/close-candidates.ts";
import {
  dryRunTick,
  operateSteps,
  runSteps,
  runTick,
  type TickOutcome,
  type TickStep,
} from "../../src/core/operate/tick.ts";
import {
  recordTriggers,
  type TriggerInput,
} from "../../src/core/operate/triggers.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { fakeGit } from "../db/close-ports.ts";
import { fakeTracker, trackerStory } from "../db/fake-tracker.ts";
import {
  createRun,
  dispatchInput,
  replay,
  started as startedWorker,
  workers,
  worktreeId,
} from "../db/run-fixture.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { runCreate } from "../../src/core/run/create.ts";
import {
  activeRevision,
  crewValue,
  hostValue,
  processValue,
} from "../db/seed.ts";
import type { StoryRef } from "../../src/core/ports/tracker.ts";
import { publishPlan } from "../db/launch-fixture.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/operate-day";
const host = "local";

interface Call {
  at: string;
  note: string;
  triggers: string[];
  lock?: "held";
  crash?: boolean;
  seed?: "finished_run" | "stopped_worker";
  workers?: { dispatchId: string; workerState: string }[];
  run_workers?: Record<
    string,
    { dispatchId: string; taskId: string; workerState: string }[]
  >;
  plan?: string[];
  launches?: { story: string; run: string }[];
  expect: {
    outcome: TickOutcome["outcome"] | "crashed";
    consumed: string[];
    closed?: string[];
    retried?: string[];
    worker_start?: boolean;
    launched?: string[];
  };
}

const day = readFileSync(join(dir, "day.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Call);

function trigger(text: string): TriggerInput {
  const [source = "", ...id] = text.split(":");
  return { source: TriggerSource.parse(source), trigger_id: id.join(":") };
}

describeDb("operate-day", () => {
  let conn: Connection;
  const triggerIds = new Map<string, number>();

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await activate("host", host, {
      ...(hostValue(2) as Record<string, Json>),
      slots: { default: 4, max: 4 },
      projects: ["widgets"],
    });
    await activeRevision(conn.db, "project", "widgets", {
      repo: "acme/widgets",
      category: "Meta",
      staging: false,
      tracker: { project_name: "Widgets", project_id: "id-widgets" },
    });
    await activate("schedule", "default", {
      tick_minutes: 15,
      hold_minutes: 60,
    });
    await activeRevision(conn.db, "policy", "default", {
      gates: ["pr"],
      story_status: { done: "Done", human_wait: "In-review" },
    });
    await activeRevision(conn.db, "crew", "default", crewValue);
    await activeRevision(conn.db, "process", "impl", processValue);
  });

  async function seedFinishedRun(at: Date): Promise<void> {
    await createRun(conn);
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    const report = CloseReport.parse({});
    await conn.db.appendEvent({
      type: "delivery",
      ts: at,
      host,
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: Json.parse({
        message_id: "m_close",
        delivery_id: "delivery_close",
        type: "status",
        outcome: "close_report",
        subject: null,
        close_report: report,
        report_hash: sha256Hex(canonicalJson(report)),
      }),
      source: { kind: "command", verb: "check" },
    });
  }

  async function seedStoppedWorker(): Promise<void> {
    const created = replay(conn, [
      ok("run-create", { run: { id: "run_2" } }),
      ok("task-create", { task: { id: "task_c", status: "ready" } }),
      ok("task-create", { task: { id: "task_s", status: "pending" } }),
    ]);
    const run = await runCreate(conn.db, created.orca, null, created.log, {
      story: "S-2",
      process: { name: "impl", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: "session-2",
      host,
      provider: "linear",
      command: "pod run create story:S-2",
      project: null,
      now: () => new Date(),
    });
    if (!run.ok) throw new Error(run.refusal.message);
    const started = replay(conn, [
      ok("worker-start", startedWorker("ctx_9", "task_c")),
    ]);
    const launched = await dispatch(
      conn.db,
      started.orca,
      started.log,
      dispatchInput({ task: "task_c" }),
    );
    if (!launched.ok) throw new Error(launched.refusal.message);
  }

  const retryArgv = [
    "--task",
    "task_c",
    "--run",
    "run_2",
    "--agent",
    "claude",
    "--model",
    "m-1",
    "--effort",
    "low",
    "--worktree",
    `id:${worktreeId}`,
    "--retry-of",
    "ctx_9",
  ];

  function launchEntries(story: string, run: string): TempEntry[] {
    const name = story.toLowerCase();
    const worktree = {
      id: `repo-1::/w/${name}`,
      path: `/w/${name}`,
      branch: `refs/heads/${name}`,
    };
    return [
      {
        verb: "worktree-show",
        argv: ["--worktree", `name:${name}`],
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "selector_not_found", message: "selector_not_found" },
        }),
      },
      ok("worktree-create", { worktree }, ["--name", name]),
      ok("run-create", { run: { id: run } }),
      ok("task-create", { task: { id: `${run}_b`, status: "ready" } }),
      ok("task-create", { task: { id: `${run}_r`, status: "pending" } }),
      ok("worker-start", startedWorker(`ctx_${run}`, `${run}_b`), [
        "--worktree",
        `id:${worktree.id}`,
      ]),
    ];
  }

  async function steps(call?: Call): Promise<readonly TickStep[]> {
    const live = await conn.db.listHostRuns(host, observedStates);
    const rowsOf = (runId: string) =>
      call?.run_workers?.[runId] ?? call?.workers ?? [];
    const listed = live.filter((each) => rowsOf(each.run_id).length > 0);
    const { orca, log } = replay(conn, [
      ...live.map((each) =>
        ok("worker-list", workers(rowsOf(each.run_id)), ["--run", each.run_id]),
      ),
      ...(call?.launches ?? []).flatMap((each) =>
        launchEntries(each.story, each.run),
      ),
      ...listed.map((each) =>
        ok("worker-list", workers(rowsOf(each.run_id)), ["--run", each.run_id]),
      ),
      ...(call?.expect.worker_start === true
        ? [ok("worker-start", startedWorker("ctx_10", "task_c"), retryArgv)]
        : []),
    ]);
    return operateSteps({
      orca,
      tracker: anyStory(),
      log,
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      worktreeStatus: () => null,
      gitStatus: () => "## main",
      provider: "linear",
      leaseSeconds: launchLeaseSeconds,
    });
  }
  afterAll(() => conn.close());

  function anyStory() {
    const tracker = fakeTracker();
    return {
      ...tracker,
      readStory: (ref: StoryRef) => {
        tracker.story = trackerStory({
          ref,
          status: "Done",
          statusType: "completed",
        });
        return tracker.readStory(ref);
      },
    };
  }

  async function activate(kind: Kind, name: string, value: Json) {
    const revision = await storeRevision(conn.db, {
      ...envelope(kind, name, value),
      scope: "host",
      scope_ref: host,
    });
    await conn.db.activate({
      scope: "host",
      scope_ref: host,
      kind,
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date(day[0]?.at ?? 0),
    });
  }

  function input(call: Call) {
    return {
      host,
      writer: host,
      actor: "person:human",
      now: new Date(call.at),
      triggers: call.triggers.map(trigger),
    };
  }

  async function tick(call: Call): Promise<TickOutcome> {
    const planned = await steps(call);
    const outcome =
      call.lock === "held"
        ? await conn.sql.begin(async (held) => {
            await held`select pg_advisory_xact_lock(hashtext(${`tick:${host}`}))`;
            return runTick(conn.db, input(call), planned);
          })
        : await runTick(conn.db, input(call), planned);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    for (const each of outcome.recorded)
      triggerIds.set(`${each.source}:${each.trigger_id}`, each.event_id);
    return outcome;
  }

  test("a day of polls and triggers, one coalesced pair, one crash and re-run, and one Run closed by the tick", async () => {
    let crashed: { tick_id: string | null; op_keys: string[] } | null = null;
    const ticks: string[] = [];
    for (const call of day) {
      if (call.plan !== undefined)
        await publishPlan(conn, new Date(call.at), "person:human", call.plan);
      if (call.crash === true) {
        const planned = await dryRunTick(conn.db, input(call), await steps());
        if (!planned.ok) throw new Error(planned.refusal.message);
        for (const each of await recordTriggers(conn.db, input(call)))
          triggerIds.set(`${each.source}:${each.trigger_id}`, each.event_id);
        const partial = await runSteps(conn.db, input(call), await steps(call));
        crashed = {
          tick_id: planned.tick_id,
          op_keys: partial.steps.map((each) => each.op_key),
        };
        expect(call.expect.outcome, call.note).toBe("crashed");
        continue;
      }
      if (call.seed === "finished_run")
        await seedFinishedRun(new Date(call.at));
      if (call.seed === "stopped_worker") await seedStoppedWorker();
      const outcome = await tick(call);
      if (call.expect.closed !== undefined) {
        const close = outcome.steps.find((each) => each.step === "close");
        expect(
          (close?.detail as { closed: { run_id: string }[] }).closed.map(
            (each) => each.run_id,
          ),
          call.note,
        ).toEqual(call.expect.closed);
      }
      expect(outcome.outcome, call.note).toBe(call.expect.outcome);
      expect(outcome.consumed, call.note).toEqual(
        call.expect.consumed.map((text) => triggerIds.get(text)),
      );
      if (outcome.tick_id !== null) ticks.push(outcome.tick_id);
      if (call.expect.launched !== undefined)
        expect(
          outcome.launch.map((each) => (each as { story: string }).story),
          call.note,
        ).toEqual(call.expect.launched);
      if (call.expect.retried !== undefined)
        expect(
          outcome.steps.find((each) => each.step === "attention")?.detail,
          call.note,
        ).toMatchObject({
          retried: call.expect.retried.map((id) => ({
            dispatch_id: id,
            ok: true,
          })),
        });
      if (crashed !== null && outcome.outcome === "ran") {
        expect(outcome.tick_id, call.note).toBe(crashed.tick_id);
        expect(
          outcome.steps.map((each) => each.op_key),
          call.note,
        ).toEqual(crashed.op_keys);
        crashed = null;
      }
    }
    expect(crashed).toBeNull();
    expect(new Set(ticks).size).toBe(ticks.length);
    const [row] = await conn.sql<{ ticks: number; triggers: number }[]>`
      select count(*) filter (where type = 'tick')::int as ticks,
        count(*) filter (where type = 'trigger')::int as triggers
      from ledger.event`;
    expect(row).toEqual({
      ticks: day.filter((call) => call.expect.outcome === "ran").length,
      triggers: 7,
    });
    const launched = await conn.sql<{ story: string; runs: number }[]>`
      select story_external_id as story, count(*)::int as runs from ledger.run
      where story_external_id in ('S-3', 'S-4') group by story_external_id
      order by story_external_id`;
    expect(launched).toEqual([
      { story: "S-3", runs: 1 },
      { story: "S-4", runs: 1 },
    ]);
    const [retries] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.dispatch where retry_of = 'ctx_9'`;
    expect(retries).toEqual({ n: 1 });
    expect((await conn.db.getRun("run_1"))?.state).toBe("done");
    const [closes] = await conn.sql<{ events: number; ops: number }[]>`
      select (select count(*)::int from ledger.event where type = 'close') as events,
        (select count(*)::int from ledger.operation where intent = 'close') as ops`;
    expect(closes?.events).toBe(1);
    expect(closes?.ops).toBeGreaterThan(0);
  });
});
