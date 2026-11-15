import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { CheckInput } from "../../src/cli/run-verbs.ts";
import {
  checkObserve,
  checkPass,
  type ObserveInput,
} from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { newestCloseReport } from "../../src/core/operate/close-candidates.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { deliveredPlan, opened } from "./decision-fixture.ts";
import { fakeTracker, trackerStory } from "./fake-tracker.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  batch,
  dispatchInput,
  empty,
  events,
  freshRun,
  message,
  replay,
  workers,
} from "./run-fixture.ts";
import { residentSeat } from "./resident-fixture.ts";

const run = ["--run", "run_1"];
const ack = (id: string) => ["--run", "run_1", "--ack", id];
const report = {
  learnings: [],
  leftovers: [{ text: "tidy the fixture", area: "impl" }],
  decisions: [],
};
const reportHash = sha256Hex(
  canonicalJson({ learnings: [], leftovers: report.leftovers, decisions: [] }),
);

function closeReport(
  id: string,
  type: string,
  over: { dispatchId?: string; report?: unknown; outcome?: string },
  from: string | null,
): unknown {
  return {
    ...(message(id, type, {
      kind: "close_report",
      report: over.report ?? report,
      ...(over.dispatchId === undefined ? {} : { dispatchId: over.dispatchId }),
      ...(over.outcome === undefined ? {} : { outcome: over.outcome }),
    }) as Record<string, unknown>),
    ...(from === null ? {} : { from_handle: from }),
  };
}

describeDb("pod check --observe", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  async function observe(
    entries: readonly TempEntry[],
    tracker: TrackerPort | null = null,
    over: Partial<ObserveInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkObserve(conn.db, orca, tracker, log, {
      run: "run_1",
      host: "local",
      capacity: 2,
      now: () => new Date(),
      leaseSeconds: launchLeaseSeconds,
      ...over,
    });
    orca.assertDone();
    return outcome;
  }

  async function coordinatorPass(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, null, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
      leaseSeconds: launchLeaseSeconds,
    });
    orca.assertDone();
    return outcome;
  }

  async function runState() {
    return (await conn.db.getRun("run_1"))?.state;
  }

  test("a tracker Canceled Story holds the Run, with no Orca check call", async () => {
    const tracker = fakeTracker(
      trackerStory({ status: "Canceled", statusType: "canceled" }),
    );
    const outcome = await observe(
      [ok("worker-list", workers([]), run)],
      tracker,
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        owner_generation: 1,
        deliveries: [],
        acked: [],
        nextSteps: expect.arrayContaining([
          "story:S-1 is Canceled in the tracker; the Run is on hold",
        ]),
      },
    });
    expect(await runState()).toBe("hold");
    expect(await events(conn, "cancel")).toHaveLength(1);
  });

  test("an unknown worker records unknown_launch and holds the Run", async () => {
    const outcome = await observe([
      ok(
        "worker-list",
        workers([
          { dispatchId: "ctx_x", taskId: "task_x", workerState: "ready" },
        ]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { unknown_workers: ["ctx_x"] },
    });
    expect(
      (await events(conn, "unknown_launch")).map((row) => row.dispatch_id),
    ).toEqual(["ctx_x"]);
    expect(await runState()).toBe("hold");
  });

  test("a pending launch past the lease is closed with no worker", async () => {
    const at = new Date();
    await expect(
      dispatch(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        dispatchInput({ capacity: 1, now: () => at }),
      ),
    ).rejects.toThrow("no Orca call expected");
    const [row] = await conn.sql<{ op_key: string }[]>`
      select op_key from ledger.operation where intent = 'dispatch' and status = 'pending'`;
    const opKey = row?.op_key ?? "";
    const outcome = await observe([ok("worker-list", workers([]), run)], null, {
      now: () => new Date(Date.now() + (launchLeaseSeconds + 1) * 1000),
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { reconciled: [{ op_key: opKey, to: "closed" }] },
    });
    expect((await conn.db.getOperation(opKey))?.status).toBe("done");
  });

  test("a queued delivery is not consumed and the coordinator's pass still records it", async () => {
    await residentSeat(conn, "ctx_lead", "decider");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_lead",
      coordinator: "term_ctx_lead",
    });
    const observed = await observe([ok("worker-list", workers([]), run)]);
    expect(observed).toMatchObject({ ok: true, result: { acked: [] } });
    expect(await events(conn, "delivery")).toHaveLength(0);
    const passed = await coordinatorPass([
      ok(
        "check",
        batch("delivery_1", [
          closeReport(
            "m_1",
            "worker_done",
            { dispatchId: "ctx_lead", outcome: "succeeded" },
            null,
          ),
        ]),
        run,
      ),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok("worker-list", workers([]), run),
    ]);
    expect(passed).toMatchObject({
      ok: true,
      result: { acked: ["delivery_1"] },
    });
    const [delivery] = await events(conn, "delivery");
    expect(delivery).toMatchObject({
      dispatch_id: "ctx_lead",
      payload: { message_id: "m_1", report_hash: reportHash },
    });
    expect(await newestCloseReport(conn.db, "run_1")).toMatchObject({
      report_hash: reportHash,
      report: { leftovers: report.leftovers },
    });
    expect(await conn.db.getDispatch("ctx_lead")).toMatchObject({
      activity: "settled",
      settlement: "done",
    });
  });

  test("an observe of another host's Run refuses wrong_host and writes nothing", async () => {
    const outcome = await observe([], null, { host: "elsewhere" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "wrong_host" },
    });
  });

  test("the CLI takes --observe only with --run and no generation, wait, or resume", () => {
    const base = { args: [], run: "run_1", observe: true };
    expect(CheckInput.safeParse(base).success).toBe(true);
    for (const extra of [
      { generation: "1" },
      { wait: true },
      { resume: true },
      { timeout: "5" },
    ])
      expect(CheckInput.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(CheckInput.safeParse({ args: [], observe: true }).success).toBe(
      false,
    );
    expect(CheckInput.safeParse({ args: [], run: "run_1" }).success).toBe(
      false,
    );
    expect(
      CheckInput.safeParse({ args: [], run: "run_1", generation: "1" }).success,
    ).toBe(true);
  });
});

describeDb("pod check records the lead's close report", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  async function pass(messages: unknown[]) {
    const { orca, log } = replay(conn, [
      ok("check", batch("delivery_1", messages), run),
      ok("check", empty("delivery_1"), ack("delivery_1")),
      ok("worker-list", workers([]), run),
    ]);
    const outcome = await checkPass(conn.db, orca, null, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
      leaseSeconds: launchLeaseSeconds,
    });
    orca.assertDone();
    return outcome;
  }

  test("a lead with no coordinator Dispatch sends from its handle", async () => {
    const outcome = await pass([closeReport("m_1", "status", {}, "session-1")]);
    expect(outcome).toMatchObject({ ok: true });
    expect(await events(conn, "delivery")).toMatchObject([
      {
        dispatch_id: null,
        payload: {
          outcome: "close_report",
          report_hash: reportHash,
          close_report: { leftovers: report.leftovers },
        },
      },
    ]);
  });

  test("a status message on the coordinator Dispatch records the report and settles nothing", async () => {
    await residentSeat(conn, "ctx_lead", "decider");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_lead",
      coordinator: "term_ctx_lead",
    });
    await pass([
      closeReport("m_1", "status", { dispatchId: "ctx_lead" }, null),
    ]);
    expect(await events(conn, "delivery")).toMatchObject([
      { dispatch_id: "ctx_lead", payload: { outcome: "close_report" } },
    ]);
    expect((await conn.db.getDispatch("ctx_lead"))?.activity).toBe("running");
  });

  test("another sender, or the handle while a coordinator Dispatch exists, is ignored", async () => {
    await pass([closeReport("m_1", "status", {}, "someone-else")]);
    await residentSeat(conn, "ctx_lead", "decider");
    await conn.db.setRunCoordinator("run_1", {
      generation: 1,
      dispatch_id: "ctx_lead",
      coordinator: "term_ctx_lead",
    });
    const { orca, log } = replay(conn, [
      ok(
        "check",
        batch("delivery_2", [
          closeReport("m_2", "status", {}, "term_ctx_lead"),
        ]),
        run,
      ),
      ok("check", empty("delivery_2"), ack("delivery_2")),
      ok("worker-list", workers([]), run),
    ]);
    await checkPass(conn.db, orca, null, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 2,
      now: () => new Date(),
      leaseSeconds: launchLeaseSeconds,
    });
    orca.assertDone();
    expect(await events(conn, "delivery")).toHaveLength(0);
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["close_report_sender", "close_report_sender"]);
    expect(await newestCloseReport(conn.db, "run_1")).toBeNull();
  });

  test("a malformed report is ignored with a next step naming the field", async () => {
    const outcome = await pass([
      closeReport("m_1", "status", { report: { learnings: "x" } }, "session-1"),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining(
            "close_report on message m_1: report.learnings",
          ),
        ]),
      },
    });
    expect(
      (await events(conn, "ignored")).map((row) => row.payload["reason"]),
    ).toEqual(["malformed_close_report"]);
  });
});

describeDb("pod check --observe charges an open Decision's budget", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  test("spent.wall_clock is persisted without a delivery read", async () => {
    const id = await opened(conn, await deliveredPlan(conn));
    const decision = await conn.db.getDecision(id);
    if (decision === null) throw new Error("no Decision");
    const at = new Date(decision.created_at.getTime() + 60_000);
    const { orca, log } = replay(conn, [ok("worker-list", workers([]), run)]);
    const outcome = await checkObserve(conn.db, orca, null, log, {
      run: "run_1",
      host: "local",
      capacity: 2,
      now: () => at,
      leaseSeconds: launchLeaseSeconds,
    });
    orca.assertDone();
    expect(outcome).toMatchObject({ ok: true });
    expect((await conn.db.getDecision(id))?.spent).toMatchObject({
      wall_clock: 60,
    });
  });
});
