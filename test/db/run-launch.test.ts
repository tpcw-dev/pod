import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { hostDay } from "../../src/core/plan/clock.ts";
import {
  endHostDrain,
  recordAttentionDrains,
} from "../../src/core/run/attention-pause.ts";
import {
  launchOpKey,
  runLaunch,
  type LaunchInput,
} from "../../src/core/run/launch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { lost, noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { createRun, dispatchInput, replay, started } from "./run-fixture.ts";
import { activeRevision, crewValue, hostValue, processValue } from "./seed.ts";

const timezone = "America/New_York";
const morning = new Date("2026-11-16T15:00:00.000Z");
const lateEvening = new Date("2026-11-17T03:30:00.000Z");
const attention = { pause_at: "22:00", max_unattended_hours: 12 };
const worktree = {
  id: "repo-1::/w/s-1",
  path: "/w/s-1",
  branch: "refs/heads/s-1",
};
const projectValue = {
  repo: "acme/widgets",
  category: "Meta",
  staging: false,
  tracker: { project_name: "Widgets", project_id: "id-widgets" },
};

function notFound(verb: string, argv: string[]): TempEntry {
  return {
    verb,
    argv,
    exitCode: 1,
    stdout: JSON.stringify({
      ok: false,
      error: { code: "selector_not_found", message: "selector_not_found" },
    }),
  };
}

const createWorktree: TempEntry[] = [
  notFound("worktree-show", ["--worktree", "name:s-1"]),
  ok("worktree-create", { worktree }, ["--project", "github:acme/widgets"]),
];

const createRunEntries: TempEntry[] = [
  ok("run-create", { run: { id: "run_1" } }),
  ok("task-create", { task: { id: "task_b", status: "ready" } }),
  ok("task-create", { task: { id: "task_r", status: "pending" } }),
];

const startLead: TempEntry = ok("worker-start", started("ctx_1"), [
  "--task",
  "task_b",
  "--worktree",
  `id:${worktree.id}`,
]);

const fullLaunch = [...createWorktree, ...createRunEntries, startLead];

describeDb("pod run launch", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  interface Seed {
    slots?: number;
    reserved?: Record<string, number>;
    policy?: Record<string, Json>;
    crew?: Json;
    process?: Json;
    actor?: string;
    now?: Date;
  }

  async function seed(over: Seed = {}): Promise<void> {
    await activeRevision(conn.db, "policy", "default", {
      gates: ["pr"],
      ...over.policy,
    });
    await activeRevision(conn.db, "crew", "default", over.crew ?? crewValue);
    await activeRevision(
      conn.db,
      "process",
      "impl",
      over.process ?? processValue,
    );
    await activeRevision(conn.db, "project", "widgets", projectValue);
    const host = await storeRevision(conn.db, {
      ...envelope("host", "local", {
        ...(hostValue(over.slots ?? 2) as Record<string, Json>),
        slots: { default: over.slots ?? 2, max: 4 },
        reserved: over.reserved ?? {},
        projects: ["widgets", "gadgets"],
      }),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "host",
      name: "local",
      expected: null,
      revision_id: host.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: morning,
    });
    if (!activated.ok) throw new Error("host not activated");
    await publish(over.now ?? morning, over.actor ?? "person:human");
  }

  async function publish(at: Date, actor: string): Promise<void> {
    const day = hostDay(at, timezone);
    await conn.db.appendEvent({
      type: "plan",
      ts: at,
      host: "local",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: `plan:${day}:${actor}`,
      payload: {
        kind: "published",
        host: "local",
        day,
        actor,
        ranked: [
          {
            key: "S-1",
            project: "widgets",
            title: "Story S-1",
            points: 2,
            place: "current",
            priority: null,
            driver: null,
            seats: ["claude"],
            reasons: [],
          },
        ],
        held: [],
        inputs: {
          host_revision: "host.local@1",
          project_revisions: [],
          tracker: null,
          usage_observation_ids: [],
          overrides: [],
        },
      },
      source: { kind: "command", verb: "plan" },
    });
  }

  function input(over: Partial<LaunchInput> = {}): LaunchInput {
    return {
      story: "S-1",
      host: "local",
      provider: "linear",
      seats: {},
      subject: "manual",
      coordinator: "session-1",
      command: "pod run launch story:S-1",
      now: () => morning,
      ...over,
    };
  }

  async function launch(
    entries: readonly TempEntry[],
    over: Partial<LaunchInput> = {},
  ) {
    const log = receiptLog(conn.db, "local");
    if (entries.length === 0)
      return runLaunch(
        conn.db,
        { orca: noCalls(), tracker: fakeTracker(), log },
        input(over),
      );
    const { orca } = replay(conn, entries);
    const outcome = await runLaunch(
      conn.db,
      { orca, tracker: fakeTracker(), log },
      input(over),
    );
    if (outcome.ok) orca.assertDone();
    return outcome;
  }

  async function operation(subject = "manual") {
    return conn.db.getOperation(launchOpKey("local", subject, "S-1"));
  }

  async function holdSlot(opKey: string, request: Record<string, Json>) {
    await conn.db.insertOperation({
      op_key: opKey,
      intent: request["launch"] === true ? "tick" : "dispatch",
      owner_generation: 0,
      at: morning,
      result_ref: { request },
    });
  }

  test("a launch claims the Story, creates its worktree and Run, and dispatches the lead Seat there", async () => {
    await seed();
    const launched = await launch(fullLaunch);
    expect(launched).toMatchObject({
      ok: true,
      result: {
        story: "story:S-1",
        run_id: "run_1",
        replayed: false,
        worktree,
        dispatch: { dispatch_id: "ctx_1", task_id: "task_b", seat: "dev-1" },
      },
    });
    expect(await operation()).toMatchObject({
      intent: "tick",
      status: "done",
      result_ref: {
        request: { launch: true, story: "S-1", project: "widgets" },
        worktree,
        run_id: "run_1",
        dispatch_id: "ctx_1",
      },
    });
    expect((await conn.db.getStory("linear", "S-1"))?.run_id).toBe("run_1");

    const again = await launch([]);
    expect(again).toMatchObject({
      ok: true,
      result: { run_id: "run_1", replayed: true, dispatch: { dispatch_id: "ctx_1" } },
    });
  });

  test("a second launch of a Story that has a Run refuses duplicate_op with no Orca call and no op", async () => {
    await seed();
    await launch(fullLaunch);
    const second = await launch([], { subject: "42" });
    expect(second).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op", message: "Story S-1 has Run run_1" },
    });
    expect(await operation("42")).toBeNull();
  });

  test("a launch in flight under another op key refuses the second first launch before Orca", async () => {
    await seed();
    await holdSlot(launchOpKey("local", "42", "S-1"), {
      launch: true,
      host: "local",
      project: "widgets",
      story: "S-1",
      subject: "42",
    });
    const second = await launch([]);
    expect(second).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
    expect(second.ok ? "" : second.refusal.message).toContain("in flight");
    expect(await operation()).toBeNull();
    await conn.db.moveOperation(
      launchOpKey("local", "42", "S-1"),
      "refused",
      null,
      morning,
    );
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("a full host refuses quota_exhausted before Orca, stores nothing, and the same op key launches once a slot frees", async () => {
    await seed({ slots: 1 });
    await holdSlot("dispatch:other", { task_id: "t-x", seat: "s", host: "local" });
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
    expect(await operation()).toBeNull();
    await conn.db.moveOperation("dispatch:other", "done", null, morning);
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("another project's unused reservation refuses quota_exhausted, a used one does not", async () => {
    await seed({ slots: 3, reserved: { gadgets: 2 } });
    await holdSlot("dispatch:other", { task_id: "t-x", seat: "s", host: "local" });
    const refused = await launch([]);
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
    expect(refused.ok ? [] : refused.refusal.nextSteps).toContain(
      "project gadgets keeps 2 reserved slots",
    );
    await conn.db.moveOperation("dispatch:other", "done", null, morning);
    await holdSlot("tick:gadgets", {
      launch: true,
      host: "local",
      project: "gadgets",
      story: "G-1",
      subject: "manual",
    });
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("this project's own reservation stays available to it", async () => {
    await seed({ slots: 1, reserved: { widgets: 1 } });
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("a pending launch reservation holds its slot against pod dispatch, and its own dispatch passes with heldBy", async () => {
    await seed({ slots: 1 });
    await createRun(conn);
    await holdSlot("tick:held", {
      launch: true,
      host: "local",
      project: "widgets",
      story: "S-9",
      subject: "manual",
    });
    const { orca, log } = replay(conn, [ok("worker-start", started("ctx_2"))]);
    const blocked = await dispatch(
      conn.db,
      orca,
      log,
      dispatchInput({ capacity: 1 }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
    const passed = await dispatch(
      conn.db,
      orca,
      log,
      dispatchInput({ capacity: 1, opKey: "dispatch:held", heldBy: "tick:held" }),
    );
    expect(passed).toMatchObject({ ok: true });
  });

  test("a usage hold on the lead Seat's runtime refuses usage_hold, stores nothing, and launches once usage has headroom", async () => {
    await seed();
    const observe = (value: string, pace: string, at: Date) =>
      conn.db.insertUsageObservation({
        provider: "claude",
        seat: null,
        window_start: at,
        window_end: at,
        value,
        coverage: "measured",
        observed_at: at,
        source: { kind: "usage record", window: "5h", pace },
      });
    await observe("80", "avoid", morning);
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "usage_hold" },
    });
    expect(await operation()).toBeNull();
    await observe("20", "ok", new Date(morning.getTime() + 1));
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("pause_at past in the host time zone refuses attention_paused, and the drain the tick records keeps it paused", async () => {
    await seed({ policy: { attention }, now: lateEvening });
    const at = { now: () => lateEvening };
    expect(await launch([], at)).toMatchObject({
      ok: false,
      refusal: { code: "attention_paused" },
    });
    expect(await operation()).toBeNull();
    const recorded = await recordAttentionDrains(conn.db, {
      host: "local",
      timezone,
      actor: "seat:tick",
      now: lateEvening,
    });
    expect(recorded).toHaveLength(1);
    expect(
      await conn.db.latestHostEvent("local", "drain", { scope: "host" }),
    ).toMatchObject({
      run_id: null,
      payload: { ended: false, scope: "host", cause: "pause_at" },
    });
    expect(await launch([], at)).toMatchObject({
      ok: false,
      refusal: { code: "attention_paused" },
    });
  });

  test("a host drain on another host does not pause this host", async () => {
    await seed({ policy: { attention } });
    await conn.db.appendEvent({
      type: "drain",
      ts: morning,
      host: "elsewhere",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: "drain:elsewhere",
      payload: { ended: false, op_key: "drain:elsewhere", scope: "host", host: "elsewhere", cause: "pause_at" },
      source: { kind: "tick", actor: "seat:tick" },
    });
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("a person's go ends the pause, and the same op key then launches", async () => {
    await seed({ policy: { attention }, now: lateEvening });
    const at = { now: () => lateEvening };
    await recordAttentionDrains(conn.db, {
      host: "local",
      timezone,
      actor: "seat:tick",
      now: lateEvening,
    });
    expect(await launch([], at)).toMatchObject({
      ok: false,
      refusal: { code: "attention_paused" },
    });
    await endHostDrain(conn.db, {
      host: "local",
      actor: "person:human",
      now: lateEvening,
    });
    expect(
      await conn.db.latestHostEvent("local", "drain", { scope: "host" }),
    ).toMatchObject({ payload: { ended: true } });
    expect(await launch(fullLaunch, at)).toMatchObject({ ok: true });
  });

  test("more than max_unattended_hours since a person's event pauses, and no person event at all pauses", async () => {
    await seed({ policy: { attention }, actor: "seat:planner" });
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "attention_paused" },
    });
    await publish(new Date(morning.getTime() - 13 * 3_600_000), "person:human");
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "attention_paused" },
    });
    await publish(new Date(morning.getTime() - 3_600_000), "person:human");
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("a Seat cannot run the go: pod drain --end refuses activation_needs_person", async () => {
    await seed({ policy: { attention } });
    const refused = runCli(["drain", "--end"], { POD_SEAT: "TPC-1/lead" });
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");
    const go = runCli(["drain", "--end"]);
    expect(go.status).toBe(0);
    expect(go.json.result).toMatchObject({ scope: "host", ended: true });
  });

  test("the lead is the first step with no dependencies; only it is dispatched", async () => {
    const twoRoots = {
      ...processValue,
      steps: [
        { id: "build", type: "worker", role: "developer", spec: "Build it." },
        { id: "survey", type: "worker", role: "reviewer", spec: "Survey it." },
      ],
      edges: [
        { from: "build", on: "done", to: "done" },
        { from: "survey", on: "done", to: "done" },
      ],
    };
    await seed({ process: twoRoots });
    const launched = await launch([
      ...createWorktree,
      ok("run-create", { run: { id: "run_1" } }),
      ok("task-create", { task: { id: "task_b", status: "ready" } }, [
        "--task-title",
        "build",
      ]),
      ok("task-create", { task: { id: "task_s", status: "ready" } }, [
        "--task-title",
        "survey",
      ]),
      startLead,
    ]);
    expect(launched).toMatchObject({
      ok: true,
      result: { dispatch: { task_id: "task_b", seat: "dev-1" } },
    });
    expect(await conn.db.listDispatches("run_1")).toHaveLength(1);
  });

  test("no Seat for the lead role refuses role_unfilled with no Orca call, even when a later root step's role is filled", async () => {
    const twoRoots = {
      ...processValue,
      steps: [
        { id: "build", type: "worker", role: "developer", spec: "Build it." },
        { id: "survey", type: "worker", role: "reviewer", spec: "Survey it." },
      ],
      edges: [
        { from: "build", on: "done", to: "done" },
        { from: "survey", on: "done", to: "done" },
      ],
    };
    await seed({
      process: twoRoots,
      crew: { seats: [{ id: "rev-1", roles: ["reviewer"], runtime: "codex" }] },
    });
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "role_unfilled" },
    });
    expect(await operation()).toBeNull();
  });

  test("--seat role=model picks the Seat with that model, and a model no Seat has refuses role_unfilled", async () => {
    await seed();
    expect(await launch([], { seats: { developer: "m-9" } })).toMatchObject({
      ok: false,
      refusal: { code: "role_unfilled" },
    });
    expect(await launch([], { seats: { reviewer: "m-1" } })).toMatchObject({
      ok: false,
      refusal: { code: "usage" },
    });
    expect(
      await launch(fullLaunch, { seats: { developer: "m-1" } }),
    ).toMatchObject({ ok: true, result: { dispatch: { seat: "dev-1" } } });
  });

  test("a stop before the worktree is recorded leaves the launch pending; the rerun adopts the worktree by name", async () => {
    await seed();
    const first = await launch([lost("worktree-show", ["--worktree", "name:s-1"])]);
    expect(first).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    expect(await operation()).toMatchObject({ status: "pending" });
    const rerun = await launch([
      ok("worktree-show", { worktree }, ["--worktree", "name:s-1"]),
      ...createRunEntries,
      startLead,
    ]);
    expect(rerun).toMatchObject({ ok: true, result: { worktree } });
  });

  test("an Orca error on worktree create keeps the launch pending, and the rerun creates it", async () => {
    await seed();
    const refused = await launch([
      notFound("worktree-show", ["--worktree", "name:s-1"]),
      {
        verb: "worktree-create",
        argv: ["--name", "s-1"],
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "project_not_found", message: "no such project" },
        }),
      },
    ]);
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "failed" },
    });
    expect(await operation()).toMatchObject({ status: "pending" });
    expect(await launch(fullLaunch)).toMatchObject({ ok: true });
  });

  test("a refused lead dispatch leaves the launch done with its code; the replay returns the refusal until a person dispatches", async () => {
    await seed();
    const refused = await launch([
      ...createWorktree,
      ...createRunEntries,
      {
        verb: "worker-start",
        argv: ["--task", "task_b"],
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "spawn_failed", message: "no agent" },
        }),
      },
    ]);
    expect(refused).toMatchObject({ ok: false, refusal: { code: "failed" } });
    expect(refused.ok ? [] : refused.refusal.nextSteps).toContain(
      "pod dispatch --task task_b --seat dev-1 --generation 1 --op-key <new>",
    );
    expect(await operation()).toMatchObject({
      status: "done",
      result_ref: { run_id: "run_1", dispatch: { code: "failed" } },
    });
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "failed" },
    });
    const { orca, log } = replay(conn, [ok("worker-start", started("ctx_7"))]);
    expect(
      await dispatch(conn.db, orca, log, dispatchInput({ opKey: "dispatch:again" })),
    ).toMatchObject({ ok: true });
    expect(await launch([])).toMatchObject({
      ok: true,
      result: { replayed: true, dispatch: { dispatch_id: "ctx_7" } },
    });
  });

  test("selector_conflict from runCreate keeps the launch pending, and the same op key completes once the selection matches", async () => {
    await seed();
    const pinned = await conn.db.getRevisionByRef("process", "impl", 1);
    if (pinned === null) throw new Error("no process.impl@1");
    const { orca, log } = replay(conn, createRunEntries);
    expect(
      await runCreate(conn.db, orca, null, log, {
        story: "S-1",
        process: { name: "impl", rev: 1 },
        size: "s",
        stage: "impl",
        coordinator: "session-1",
        host: "local",
        provider: "linear",
        command: "pod run create story:S-1",
        project: "widgets",
        now: () => morning,
      }),
    ).toMatchObject({ ok: true });
    await conn.db.insertOperation({
      op_key: launchOpKey("local", "manual", "S-1"),
      intent: "tick",
      owner_generation: 0,
      at: morning,
      result_ref: {
        request: {
          launch: true,
          host: "local",
          project: "widgets",
          story: "S-1",
          subject: "manual",
        },
        worktree,
      },
    });
    const swap = async (from: string, to: string) => {
      const swapped = await conn.db.activate({
        scope: "global",
        scope_ref: "",
        kind: "process",
        name: "impl",
        expected: from,
        revision_id: to,
        bundle_id: null,
        activated_by: "operator",
        activated_at: morning,
      });
      if (!swapped.ok) throw new Error("process not swapped");
    };
    const second = await storeRevision(
      conn.db,
      envelope("process", "impl", { ...processValue, summary: "second" }),
    );
    await swap(pinned.id, second.id);
    expect(await launch([])).toMatchObject({
      ok: false,
      refusal: { code: "selector_conflict" },
    });
    expect(await operation()).toMatchObject({ status: "pending" });
    await swap(second.id, pinned.id);
    expect(await launch([startLead])).toMatchObject({
      ok: true,
      result: { run_id: "run_1", dispatch: { dispatch_id: "ctx_1" } },
    });
  });
});
