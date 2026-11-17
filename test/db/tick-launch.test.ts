import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  operateSteps,
  runTick,
  type TickOutcome,
  type TickStep,
} from "../../src/core/operate/tick.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { endHostDrain } from "../../src/core/run/attention-pause.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fakeGit } from "./close-ports.ts";
import type { StoryRef } from "../../src/core/ports/tracker.ts";
import { fakeTracker, trackerStory } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import {
  attention,
  createRunEntries,
  createWorktree,
  fullLaunch,
  lateEvening,
  morning,
  noSender,
  publishPlan,
  seedLaunch,
  startLead,
  worktree,
  type Seed,
} from "./launch-fixture.ts";
import { replay, started } from "./run-fixture.ts";

const minutes = (at: Date, n: number) => new Date(at.getTime() + n * 60_000);

function anyStory() {
  const tracker = fakeTracker();
  return {
    ...tracker,
    readStory: (ref: StoryRef) => {
      tracker.story = trackerStory({ ref });
      return tracker.readStory(ref);
    },
  };
}

function ran(outcome: TickOutcome | Refused): TickOutcome {
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome;
}

describeDb("the tick's launch step", () => {
  let conn: Connection;
  let trigger = 0;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function seed(over: Seed = {}) {
    await seedLaunch(conn, over);
    const schedule = await storeRevision(conn.db, {
      ...envelope("schedule", "default", {
        tick_minutes: 15,
        hold_minutes: 60,
      }),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "schedule",
      name: "default",
      expected: null,
      revision_id: schedule.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: morning,
    });
    if (!activated.ok) throw new Error("schedule not activated");
  }

  function steps(orca: OrcaPort): readonly TickStep[] {
    const idle = (): Promise<{ result: "ok"; detail: null }> =>
      Promise.resolve({ result: "ok", detail: null });
    return operateSteps({
      orca,
      tracker: anyStory(),
      log: receiptLog(conn.db, "local"),
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      worktreeStatus: () => null,
      gitStatus: () => "## main",
      provider: "linear",
      leaseSeconds: launchLeaseSeconds,
    }).map((step) =>
      ["observe", "close", "attention"].includes(step.name)
        ? { ...step, run: idle }
        : step,
    );
  }

  async function tick(at: Date, entries: readonly TempEntry[] = []) {
    trigger += 1;
    const orca = entries.length === 0 ? noCalls() : replay(conn, entries).orca;
    const outcome = ran(
      await runTick(
        conn.db,
        {
          host: "local",
          writer: "local",
          actor: "seat:tick",
          now: at,
          triggers: [{ source: "operator", trigger_id: `t-${trigger}` }],
        },
        steps(orca),
      ),
    );
    return outcome;
  }

  async function runs(): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.run`;
    return row?.n ?? -1;
  }

  test("a tick launches the plan's Story and lists it; the next tick launches nothing", async () => {
    await seed();
    const first = await tick(morning, fullLaunch);
    expect(first.steps.find((each) => each.step === "launch")).toMatchObject({
      result: "ok",
    });
    expect(first.launch).toEqual([
      expect.objectContaining({
        story: "S-1",
        run_id: "run_1",
        dispatch_id: "ctx_1",
        replayed: false,
      }),
    ]);
    expect(first.refuse).toEqual([]);
    const second = await tick(minutes(morning, 1));
    expect(second.launch).toEqual([]);
    expect(await runs()).toBe(1);
  });

  test("the launch loop stops at quota_exhausted and lists it with no hold", async () => {
    await seed({ slots: 1 });
    await publishPlan(conn, minutes(morning, 1), "person:human", [
      "S-1",
      "S-2",
    ]);
    const first = await tick(minutes(morning, 2), fullLaunch);
    expect(first.launch).toMatchObject([{ story: "S-1" }]);
    expect(first.refuse).toMatchObject([
      { story: "S-2", code: "quota_exhausted" },
    ]);
  });

  test("a usage_hold refusal is skipped for hold_minutes, then the same op key launches", async () => {
    await seed();
    await conn.db.insertUsageObservation({
      provider: "claude",
      seat: null,
      window_start: morning,
      window_end: morning,
      value: "80",
      coverage: "measured",
      observed_at: morning,
      source: { kind: "usage record", window: "5h", pace: "avoid" },
    });
    const held = await tick(morning);
    expect(held.refuse).toMatchObject([{ story: "S-1", code: "usage_hold" }]);
    const skipped = await tick(minutes(morning, 30));
    expect(skipped.refuse).toEqual([]);
    expect(skipped.launch).toEqual([]);
    const later = minutes(morning, 61);
    await conn.db.insertUsageObservation({
      provider: "claude",
      seat: null,
      window_start: later,
      window_end: later,
      value: "20",
      coverage: "measured",
      observed_at: later,
      source: { kind: "usage record", window: "5h", pace: "ok" },
    });
    const launched = await tick(later, fullLaunch);
    expect(launched.launch).toMatchObject([{ story: "S-1" }]);
  });

  test("a failed run-create is held for hold_minutes, then the tick relaunches it as the next attempt", async () => {
    await seed();
    const failed = await tick(morning, [
      ...createWorktree,
      noSender("run-create"),
    ]);
    expect(failed.refuse).toMatchObject([{ story: "S-1", code: "failed" }]);
    const skipped = await tick(minutes(morning, 30));
    expect(skipped.refuse).toEqual([]);
    expect(skipped.launch).toEqual([]);
    const relaunched = await tick(minutes(morning, 61), [
      ok("worktree-show", { worktree }, ["--worktree", "name:s-1"]),
      ...createRunEntries,
      startLead,
    ]);
    expect(relaunched.launch).toMatchObject([
      { story: "S-1", run_id: "run_1", op_key: expect.stringMatching(/:2$/) },
    ]);
    expect(await runs()).toBe(1);
  });

  test("past pause_at the tick records the host drain and launches nothing, again on the next tick, until a person's go", async () => {
    await seed({ policy: { attention }, now: lateEvening });
    const paused = await tick(lateEvening);
    expect(paused.launch).toEqual([]);
    expect(paused.refuse).toMatchObject([
      { story: "S-1", code: "attention_paused" },
    ]);
    expect(
      paused.steps.find((each) => each.step === "launch")?.detail,
    ).toMatchObject({ drains: [expect.any(String)] });
    const still = await tick(minutes(lateEvening, 1));
    expect(still.refuse).toMatchObject([
      { story: "S-1", code: "attention_paused" },
    ]);
    await endHostDrain(conn.db, {
      host: "local",
      actor: "person:human",
      now: minutes(lateEvening, 2),
    });
    const resumed = await tick(minutes(lateEvening, 3), fullLaunch);
    expect(resumed.launch).toMatchObject([{ story: "S-1" }]);
  });

  test("a tick that stopped after run_create resumes the same launch op and dispatches the lead with no second Run", async () => {
    await seed();
    const { orca } = replay(conn, fullLaunch.slice(0, 5));
    let versions = 0;
    const crashing: OrcaPort = {
      ...orca,
      version: () => {
        versions += 1;
        return versions === 3
          ? Promise.reject(new Error("killed before dispatch"))
          : orca.version();
      },
    };
    const crashed = ran(
      await runTick(
        conn.db,
        {
          host: "local",
          writer: "local",
          actor: "seat:tick",
          now: morning,
          triggers: [{ source: "operator", trigger_id: "crash" }],
        },
        steps(crashing),
      ),
    );
    expect(crashed.steps.find((each) => each.step === "launch")).toMatchObject({
      result: "failed",
    });
    expect(await runs()).toBe(1);
    const resumed = await tick(minutes(morning, 1), [
      ok("worker-start", started("ctx_1")),
    ]);
    expect(resumed.launch).toMatchObject([
      { story: "S-1", run_id: "run_1", dispatch_id: "ctx_1" },
    ]);
    expect(await runs()).toBe(1);
  });

  test("a Story whose project has no seated project Revision is held, and the next Story still launches", async () => {
    await seed();
    await publishPlan(
      conn,
      minutes(morning, 1),
      "person:human",
      ["G-1", "S-1"],
      (key) => (key === "G-1" ? "gadgets" : "widgets"),
    );
    const first = await tick(minutes(morning, 2), fullLaunch);
    expect(first.refuse).toMatchObject([
      { story: "G-1", code: "selector_none" },
    ]);
    expect(first.launch).toMatchObject([{ story: "S-1" }]);
  });
});
