import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { closeCandidates } from "../../src/core/operate/close-candidates.ts";
import type { OperatePorts } from "../../src/core/operate/ports.ts";
import {
  operateSteps,
  runTick,
  type TickOutcome,
} from "../../src/core/operate/tick.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fakeGit } from "./close-ports.ts";
import { fakeTracker, trackerStory } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { residentSeat } from "./resident-fixture.ts";
import { createRun, replay, workers } from "./run-fixture.ts";
import { activeRevision, crewValue, processValue, seedHost } from "./seed.ts";

const t0 = new Date("2026-11-15T16:00:00.000Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);
const run = ["--run", "run_1"];
const storyStatus = { done: "Done", human_wait: "In-review" };
const report = CloseReport.parse({
  leftovers: [{ text: "rename the fixture", area: "impl" }],
});
const reportHash = sha256Hex(canonicalJson(report));

let conn: Connection;

function done(): TrackerPort {
  return fakeTracker(trackerStory({ status: "Done", statusType: "completed" }));
}

function ports(
  entries: readonly TempEntry[],
  tracker: TrackerPort | null,
): { ports: OperatePorts; assertDone: () => void } {
  const { orca, log } = replay(conn, entries);
  return {
    ports: {
      orca,
      tracker,
      log,
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      worktreeStatus: () => ({ files: [], ahead: 0 }),
      gitStatus: () => "## main",
      provider: "linear",
      leaseSeconds: launchLeaseSeconds,
    },
    assertDone: () => orca.assertDone(),
  };
}

const observed = () => [ok("worker-list", workers([]), run)];

async function tick(
  at: Date,
  entries: readonly TempEntry[],
  tracker: TrackerPort | null = done(),
): Promise<TickOutcome> {
  const wired = ports(entries, tracker);
  const outcome: TickOutcome | Refused = await runTick(
    conn.db,
    {
      host: "local",
      writer: "local",
      actor: "person:human",
      now: at,
      triggers: [{ source: "operator", trigger_id: at.toISOString() }],
    },
    operateSteps(wired.ports),
  );
  wired.assertDone();
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome;
}

function closeDetail(outcome: TickOutcome) {
  const step = outcome.steps.find((each) => each.step === "close");
  return step?.detail as {
    closed: Json[];
    needs_human: Record<string, unknown>[];
  };
}

async function recordReport(): Promise<void> {
  await conn.db.appendEvent({
    type: "delivery",
    ts: t0,
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: {
      message_id: "m_1",
      delivery_id: "delivery_1",
      type: "status",
      outcome: "close_report",
      subject: null,
      close_report: report,
      report_hash: reportHash,
    } as Json,
    source: { kind: "command", verb: "check" },
  });
}

async function setStatus(status: string): Promise<void> {
  await conn.sql`update ledger.story set status = ${status}`;
}

async function closeEvents(): Promise<number> {
  const [row] = await conn.sql<{ n: number }[]>`
    select count(*)::int as n from ledger.event where type = 'close'`;
  return row?.n ?? 0;
}

async function closeOps(): Promise<string[]> {
  return (
    await conn.sql<{ op_key: string }[]>`
      select op_key from ledger.operation where intent = 'close' order by op_key`
  ).map((row) => row.op_key);
}

describeDb("pod tick closes finished Runs", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await clearDb(conn);
    await activeRevision(conn.db, "policy", "default", {
      gates: ["pr"],
      story_status: storyStatus,
    });
    await activeRevision(conn.db, "crew", "default", crewValue);
    await activeRevision(conn.db, "process", "impl", processValue);
    await seedHost(conn.db);
    const schedule = await storeRevision(conn.db, {
      ...envelope("schedule", "default", {
        tick_minutes: 15,
        hold_minutes: 60,
      }),
      scope: "host",
      scope_ref: "local",
    });
    await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "schedule",
      name: "default",
      expected: null,
      revision_id: schedule.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: t0,
    });
    await createRun(conn);
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
  });
  afterAll(() => conn.close());

  test("a candidate is a Run of the host at the policy's done status with every Task finished", async () => {
    await setStatus("Done");
    expect(
      (await closeCandidates(conn.db, "local")).map((each) => each.run.run_id),
    ).toEqual(["run_1"]);
    expect(await closeCandidates(conn.db, "elsewhere")).toEqual([]);
    await setStatus("In-review");
    expect(await closeCandidates(conn.db, "local")).toEqual([]);
    await setStatus("Done");
    await conn.db.setTaskState("task_r", "ready");
    expect(await closeCandidates(conn.db, "local")).toEqual([]);
  });

  test("the tick closes the Run once from its lead's report, and a later tick leaves it alone", async () => {
    await recordReport();
    const first = await tick(minutes(0), observed());
    expect(first.steps.find((each) => each.step === "observe")).toMatchObject({
      result: "ok",
      detail: { runs: [{ run_id: "run_1", result: "ok" }] },
    });
    expect(closeDetail(first)).toEqual({
      closed: [
        { run_id: "run_1", already_closed: false, report_hash: reportHash },
      ],
      needs_human: [],
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("done");
    const ops = await closeOps();
    expect(ops.length).toBeGreaterThan(0);
    const second = await tick(minutes(16), []);
    expect(closeDetail(second)).toEqual({ closed: [], needs_human: [] });
    expect(await closeOps()).toEqual(ops);
    expect(await closeEvents()).toBe(1);
  });

  test("no report writes a needs_human line held until the Run gains an event", async () => {
    const first = await tick(minutes(0), observed());
    const [line] = closeDetail(first).needs_human;
    expect(line).toMatchObject({
      run_id: "run_1",
      story: "story:S-1",
      code: "no_close_report",
      since: minutes(0).toISOString(),
      held: false,
    });
    const held = await tick(minutes(5), observed());
    expect(closeDetail(held).needs_human).toEqual([{ ...line, held: true }]);
    await recordReport();
    const released = await tick(minutes(10), observed());
    expect(closeDetail(released)).toMatchObject({
      closed: [{ run_id: "run_1" }],
      needs_human: [],
    });
  });

  test("a held line is released once hold_minutes pass", async () => {
    await tick(minutes(0), observed());
    const held = await tick(minutes(59), observed());
    expect(closeDetail(held).needs_human).toMatchObject([
      { held: true, since: minutes(0).toISOString() },
    ]);
    const released = await tick(minutes(60), observed());
    expect(closeDetail(released).needs_human).toMatchObject([
      {
        code: "no_close_report",
        held: false,
        since: minutes(60).toISOString(),
      },
    ]);
  });

  test("a running Dispatch, the coordinator's included, holds the close", async () => {
    await recordReport();
    await residentSeat(conn, "ctx_lead", "decider");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_lead",
      coordinator: "term_ctx_lead",
    });
    const outcome = await tick(minutes(0), observed());
    expect(closeDetail(outcome).needs_human).toMatchObject([
      {
        code: "dispatch_running",
        message: expect.stringContaining("ctx_lead"),
      },
    ]);
    expect((await conn.db.getRun("run_1"))?.state).not.toBe("done");
    expect(await closeOps()).toEqual([]);
  });

  test("a refused close writes the refusal as a needs_human line", async () => {
    await recordReport();
    await setStatus("Done");
    const outcome = await tick(minutes(0), observed(), null);
    expect(closeDetail(outcome).needs_human).toMatchObject([
      { run_id: "run_1", code: "tracker_unconfirmed", held: false },
    ]);
    expect((await conn.db.getRun("run_1"))?.state).not.toBe("done");
  });
});
