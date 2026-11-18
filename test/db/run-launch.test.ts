import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import type { Json } from "../../src/core/domain/json.ts";
import {
  endHostDrain,
  recordAttentionDrains,
} from "../../src/core/run/attention-pause.ts";
import {
  launchOpKey,
  runLaunch,
  type LaunchInput,
} from "../../src/core/run/launch.ts";
import { failure } from "../../src/core/ledger/launch.ts";
import { derivedOpKey } from "../../src/core/ledger/op-key.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { lost, noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { createRun, dispatchInput, replay, started } from "./run-fixture.ts";
import {
  attention,
  createRunEntries,
  createWorktree,
  fullLaunch,
  lateEvening,
  morning,
  noSender,
  notFound,
  publishPlan,
  seedLaunch,
  startLead,
  timezone,
  worktree,
  type Seed,
} from "./launch-fixture.ts";
import { processValue } from "./seed.ts";

describeDb("pod run launch", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  const seed = (over: Seed = {}) => seedLaunch(conn, over);
  const publish = (at: Date, actor: string) => publishPlan(conn, at, actor);

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
      result: {
        run_id: "run_1",
        replayed: true,
        dispatch: { dispatch_id: "ctx_1" },
      },
    });
  });

  test("a launch from a shell with no terminal handle passes the coordinator as --from on run-create, task-create, and the lead worker-start", async () => {
    await seed();
    const from = ["--from", "term_coord"];
    const launched = await launch(
      [
        ...createWorktree,
        ok("run-create", { run: { id: "run_1" } }, from),
        ok("task-create", { task: { id: "task_b", status: "ready" } }, from),
        ok("task-create", { task: { id: "task_r", status: "pending" } }, from),
        ok("worker-start", started("ctx_1"), ["--task", "task_b", ...from]),
      ],
      { coordinator: "term_coord" },
    );
    expect(launched).toMatchObject({ ok: true, result: { run_id: "run_1" } });
    const sent = await conn.sql<{ verb: string; argv: string[] }[]>`
      select payload->>'verb' as verb, payload->'argv' as argv
      from ledger.event where type = 'receipt' order by id`;
    const orchestration = sent.filter((row) =>
      ["run-create", "task-create", "worker-start"].includes(row.verb),
    );
    expect(orchestration.map((row) => row.verb)).toEqual([
      "run-create",
      "task-create",
      "task-create",
      "worker-start",
    ]);
    for (const row of orchestration)
      expect(row.argv.join(" ")).toContain("--from term_coord");
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
    await holdSlot("dispatch:other", {
      task_id: "t-x",
      seat: "s",
      host: "local",
    });
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
    await holdSlot("dispatch:other", {
      task_id: "t-x",
      seat: "s",
      host: "local",
    });
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
      dispatchInput({
        capacity: 1,
        opKey: "dispatch:held",
        heldBy: "tick:held",
      }),
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
      payload: {
        ended: false,
        op_key: "drain:elsewhere",
        scope: "host",
        host: "elsewhere",
        cause: "pause_at",
      },
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
    expect(runCli(["drain", "--run", "run_1"]).status).toBe(2);
    expect(runCli(["drain"]).status).toBe(2);
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
    const first = await launch([
      lost("worktree-show", ["--worktree", "name:s-1"]),
    ]);
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

  const runCreateKey = derivedOpKey("run_create", {
    provider: "linear",
    external_id: "S-1",
  });
  const adoptWorktree = ok("worktree-show", { worktree }, [
    "--worktree",
    "name:s-1",
  ]);

  async function operationsOf(intent: string) {
    return conn.sql<{ op_key: string; status: string }[]>`
      select op_key, status from ledger.operation
      where intent = ${intent} order by created_at, op_key`;
  }

  test("a no-sender run-create refusal, then a retry with the sender, launches", async () => {
    await seed();
    const refused = await launch([...createWorktree, noSender("run-create")]);
    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: "failed",
        message: expect.stringContaining(worktree.id),
        nextSteps: ["pod run launch story:S-1", "pod check"],
      },
    });
    expect(await operation()).toMatchObject({
      status: "refused",
      result_ref: { code: "failed", worktree },
    });

    const from = ["--from", "term_coord"];
    const retried = await launch(
      [
        adoptWorktree,
        ok("run-create", { run: { id: "run_1" } }, from),
        ok("task-create", { task: { id: "task_b", status: "ready" } }, from),
        ok("task-create", { task: { id: "task_r", status: "pending" } }, from),
        ok("worker-start", started("ctx_1"), ["--task", "task_b", ...from]),
      ],
      { coordinator: "term_coord" },
    );
    const launchKey = launchOpKey("local", "manual", "S-1");
    expect(retried).toMatchObject({
      ok: true,
      result: {
        run_id: "run_1",
        op_key: `${launchKey}:2`,
        worktree: { id: worktree.id },
        dispatch: { dispatch_id: "ctx_1", task_id: "task_b", seat: "dev-1" },
      },
    });
    expect(await operationsOf("tick")).toEqual([
      { op_key: launchKey, status: "refused" },
      { op_key: `${launchKey}:2`, status: "done" },
    ]);
    expect(await operationsOf("run_create")).toEqual([
      { op_key: runCreateKey, status: "done" },
      { op_key: `${runCreateKey}:2`, status: "done" },
    ]);
    expect(await launch([])).toMatchObject({
      ok: true,
      result: { run_id: "run_1", replayed: true, op_key: `${launchKey}:2` },
    });
  });

  test("a Story whose run-create and launch were refused failed before this release launches on the next run", async () => {
    await seed();
    const launchKey = launchOpKey("local", "manual", "S-1");
    const request = {
      launch: true,
      host: "local",
      project: "widgets",
      story: "S-1",
      subject: "manual",
    };
    await conn.db.insertOperation({
      op_key: runCreateKey,
      intent: "run_create",
      owner_generation: 1,
      at: morning,
    });
    await conn.db.moveOperation(
      runCreateKey,
      "done",
      failure("run-create", { ok: false }, 1),
      morning,
    );
    await conn.db.insertOperation({
      op_key: launchKey,
      intent: "tick",
      owner_generation: 0,
      at: morning,
      result_ref: { request },
    });
    await conn.db.moveOperation(
      launchKey,
      "refused",
      {
        request,
        worktree,
        code: "failed",
        message: "run-create for story:S-1 failed",
        nextSteps: ["pod check"],
      },
      morning,
    );
    expect(
      await launch([adoptWorktree, ...createRunEntries, startLead]),
    ).toMatchObject({
      ok: true,
      result: { run_id: "run_1", worktree, op_key: `${launchKey}:2` },
    });
  });

  test("no run-create attempt opens while attempt 1 is unknown", async () => {
    await seed();
    const requestId = "44444444-4444-4444-8444-444444444444";
    await conn.db.insertOperation({
      op_key: runCreateKey,
      intent: "run_create",
      owner_generation: 1,
      at: morning,
    });
    await conn.db.moveOperation(
      runCreateKey,
      "unknown",
      { verb: "run-create", requestId },
      morning,
    );
    const outcome = await launch([
      ...createWorktree,
      ok("request-show", { requestId, state: "pending" }, [
        "--request",
        requestId,
      ]),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    expect(await operationsOf("run_create")).toEqual([
      { op_key: runCreateKey, status: "unknown" },
    ]);
    expect(await operation()).toMatchObject({ status: "pending" });
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
    expect(refused.ok ? [] : refused.refusal.nextSteps).toEqual([
      expect.stringMatching(
        /^pod dispatch --task task_b --seat dev-1 --generation 1 --op-key dispatch:[0-9a-f]+$/,
      ),
      "pod check",
      "pod dispatch --task task_b --seat dev-1 --generation 1 --op-key <new>",
    ]);
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
      await dispatch(
        conn.db,
        orca,
        log,
        dispatchInput({ opKey: "dispatch:again" }),
      ),
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

  test("pod run launch needs a coordinator, and refuses a Story the host's plan does not name", async () => {
    await seed();
    const bare = runCli(["run", "launch", "story:S-1"], {
      POD_COORDINATOR: "",
    });
    expect(bare.status).toBe(2);
    expect(bare.json.error?.nextSteps).toEqual([
      "set POD_COORDINATOR to the coordinator's Orca terminal handle",
    ]);
    const missing = runCli(["run", "launch", "story:S-404"], {
      POD_COORDINATOR: "session-1",
    });
    expect(missing.status).toBe(3);
    expect(missing.json.error).toMatchObject({
      code: "selector_none",
      message: "story:S-404 is in no published plan for host local today",
    });
  });

  test("plan, lead, and gate refusals make no Orca call, not even a version read", async () => {
    await seed({ slots: 1 });
    const silent = {
      ...noCalls(),
      version: () => Promise.reject(new Error("no Orca call expected")),
    };
    const log = receiptLog(conn.db, "local");
    const run = (story: string) =>
      runLaunch(
        conn.db,
        { orca: silent, tracker: fakeTracker(), log },
        input({ story }),
      );
    expect(await run("S-404")).toMatchObject({
      ok: false,
      refusal: { code: "selector_none" },
    });
    await holdSlot("dispatch:other", {
      task_id: "t-x",
      seat: "s",
      host: "local",
    });
    expect(await run("S-1")).toMatchObject({
      ok: false,
      refusal: { code: "quota_exhausted" },
    });
  });
});
