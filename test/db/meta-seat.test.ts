import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { hostFreeSlots } from "../../src/core/dispatch/quota.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runMetaSteps } from "../../src/core/operate/meta.ts";
import type { MetaSeatRequest } from "../../src/core/operate/meta-digest.ts";
import {
  metaSeat,
  seatFile,
  seatObserved,
  seatOpKey,
  type MetaSeatDeps,
} from "../../src/core/operate/meta-seat.ts";
import {
  metaStepOpKey,
  readWatermark,
} from "../../src/core/operate/watermark.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import {
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { learn, metaProcess, morningPolicy } from "./meta-digest-seed.ts";
import { activate, host, metaTable, seedMeta } from "./meta-seed.ts";
import { replay, workers } from "./run-fixture.ts";

const at = new Date("2026-11-15T10:30:00.000Z");
const stepKey = metaStepOpKey("digest", "global", null);
const digestSeat = {
  id: "digest-1",
  roles: ["digest"],
  runtime: "claude",
  model: "m-1",
};

let conn: Connection;
let home: string;
let revisions: { crew: string; process: string; policy: string };
let learningId: number;

function started(dispatchId: string, runId: string | null = "run_w") {
  return {
    dispatchId,
    state: "ready",
    taskId: `task_${dispatchId}`,
    terminalHandle: `term_${dispatchId}`,
    ...(runId === null ? {} : { runId, run: { id: runId, created: true } }),
    launch: {
      requested: { agent: "claude", model: "m-1" },
      effective: { agent: "claude", model: "m-1" },
    },
  };
}

function listed(dispatchId: string, workerState: string, run = "run_w") {
  return ok(
    "worker-list",
    {
      ...(workers([{ dispatchId, workerState }]) as Record<string, unknown>),
      scope: { run, source: "flag" },
    },
    ["--run", run],
  );
}

function stopped(dispatchId: string): TempEntry {
  return ok("worker-stop", { dispatchId, state: "stopped" });
}

function writeFile(attempt = 1): void {
  const file = seatFile(home, seatOpKey(stepKey, attempt));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `- theme: retries\n  text: Retry the flaky step once.\n  learning_ids: [${learningId}]\n  evidence_refs: ["pr:flaky"]\n`,
  );
}

function deps(orca: OrcaPort, over: Partial<MetaSeatDeps> = {}): MetaSeatDeps {
  return {
    db: conn.db,
    orca,
    log: receiptLog(conn.db, host),
    host,
    home,
    now: () => at,
    pause: () => Promise.resolve(),
    ...over,
  };
}

function request(signal = new AbortController().signal): MetaSeatRequest {
  return {
    step: "digest",
    role: "digest",
    method: "Theme the packet's learnings into proposals.",
    scope: "global",
    opKey: stepKey,
    packet: "digest packet for global: 1 items",
    signal,
  };
}

async function digestStep(orca: OrcaPort, over: Partial<MetaSeatDeps> = {}) {
  const [record] = await runMetaSteps(
    conn.db,
    { host, writer: host, actor: "person:human", now: at },
    ["digest"],
    metaTable(conn, { seat: metaSeat(deps(orca, over)) }),
  );
  return record;
}

async function operation(attempt: number) {
  return conn.db.getOperation(seatOpKey(stepKey, attempt));
}

async function seedSeat(crewSeats: Json[] = [digestSeat]) {
  await seedMeta(conn, undefined, morningPolicy);
  const [policy] = await conn.db.listActivations("policy", "global", "");
  const process = await activate(
    conn,
    "process",
    "meta",
    "global",
    "",
    metaProcess,
  );
  const crew = await activate(conn, "crew", "default", "global", "", {
    seats: crewSeats,
  });
  revisions = { crew, process, policy: policy?.revision_id ?? "" };
}

describeDb("the production meta Seat", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await clearDb(conn);
    home = mkdtempSync(join(tmpdir(), "pod-meta-seat-"));
    await seedSeat();
    learningId = await learn(conn, "the flaky step failed twice", at);
  });
  afterAll(() => conn.close());

  test("a Seat that writes its FILE is posted, and the Revision ids reach the start and digest events", async () => {
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_meta"), [
        "--worktree",
        `path:${join(home, "meta")}`,
      ]),
      listed("ctx_meta", "running"),
      listed("ctx_meta", "ready"),
      stopped("ctx_meta"),
    ]);
    const record = await digestStep(orca, {
      log,
      pause: () => {
        writeFile();
        return Promise.resolve();
      },
    });
    orca.assertDone();
    expect(record).toMatchObject({ step: "digest", result: "ok" });
    expect(await conn.db.getDispatch("ctx_meta")).toMatchObject({
      run_id: null,
      task_id: null,
      decision_id: null,
      owner_host: host,
      role: "digest",
      seat: "digest-1",
      settlement: "done",
      activity: "settled",
      manifest_id: null,
      requested_launch: { worker_run: "run_w", revisions },
    });
    const [start] = await conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event where type = 'start' and dispatch_id = 'ctx_meta'`;
    expect(start?.payload).toMatchObject({ revisions });
    const [digest] = await conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event where type = 'digest' and payload ? 'meta'`;
    expect(digest?.payload).toMatchObject({ revisions });
  });

  test("no active global crew is config_missing, and nothing starts", async () => {
    await clearDb(conn);
    await seedMeta(conn, undefined, morningPolicy);
    await activate(conn, "process", "meta", "global", "", metaProcess);
    learningId = await learn(conn, "the flaky step failed twice", at);
    const record = await digestStep(noCalls());
    expect(record).toMatchObject({
      result: "failed",
      detail: { code: "seat_failed" },
    });
    expect(JSON.stringify(record?.detail)).toContain("config_missing");
    expect(await operation(1)).toBeNull();
  });

  test("a crew with only another role is role_unfilled", async () => {
    await clearDb(conn);
    await seedSeat([{ id: "dev-1", roles: ["developer"], runtime: "claude" }]);
    learningId = await learn(conn, "the flaky step failed twice", at);
    const record = await digestStep(noCalls());
    expect(JSON.stringify(record?.detail)).toContain("role_unfilled");
    expect(await operation(1)).toBeNull();
  });

  test("a full host is quota_exhausted: no worker start, step failed, watermark unchanged", async () => {
    for (const key of ["held:1", "held:2"])
      await conn.db.insertOperation({
        op_key: key,
        intent: "tick",
        owner_generation: 0,
        at,
        result_ref: { request: { host, launch: true } },
      });
    const record = await digestStep(noCalls());
    expect(record).toMatchObject({ result: "failed" });
    expect(JSON.stringify(record?.detail)).toContain("quota_exhausted");
    expect(await operation(1)).toBeNull();
    expect(
      await readWatermark(conn.db, "digest", "digest", "global"),
    ).toBeNull();
  });

  test("packet_minutes passing stops the worker, settles the Dispatch, posts nothing, and the next run starts attempt 2", async () => {
    const controller = new AbortController();
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_slow")),
      listed("ctx_slow", "running"),
      stopped("ctx_slow"),
    ]);
    const outcome = await metaSeat(
      deps(orca, {
        log,
        pause: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    ).run(request(controller.signal));
    orca.assertDone();
    expect(outcome.ok).toBe(false);
    expect(await conn.db.getDispatch("ctx_slow")).toMatchObject({
      settlement: "stopped",
      activity: "settled",
    });
    expect(await seatObserved(conn.db, stepKey, 1)).toBe(true);
    const posted =
      await conn.sql`select 1 from ledger.event where type = 'digest'`;
    expect(posted).toHaveLength(0);
    const next = replay(conn, [
      ok("worker-start", started("ctx_second")),
      listed("ctx_second", "succeeded"),
    ]);
    await metaSeat(deps(next.orca, { log: next.log })).run(request());
    next.orca.assertDone();
    expect((await operation(2))?.status).toBe("done");
  });

  test("a rerun with an open Dispatch under the same op key waits on it and starts no second worker", async () => {
    const controller = new AbortController();
    const first = replay(conn, [
      ok("worker-start", started("ctx_open")),
      listed("ctx_open", "running"),
      {
        verb: "worker-stop",
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: { code: "busy" } }),
      },
    ]);
    const outcome = await metaSeat(
      deps(first.orca, {
        log: first.log,
        pause: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    ).run(request(controller.signal));
    first.orca.assertDone();
    expect(outcome.ok).toBe(false);
    expect((await conn.db.getDispatch("ctx_open"))?.settlement).toBe("open");
    const second = replay(conn, [
      listed("ctx_open", "running"),
      listed("ctx_open", "ready"),
      stopped("ctx_open"),
    ]);
    const resumed = await metaSeat(
      deps(second.orca, {
        log: second.log,
        pause: () => {
          writeFile();
          return Promise.resolve();
        },
      }),
    ).run(request());
    second.orca.assertDone();
    expect(resumed).toEqual({
      ok: true,
      file: seatFile(home, seatOpKey(stepKey, 1)),
    });
    expect(await operation(2)).toBeNull();
  });

  test("a rerun with the FILE present uses it and calls the worker runtime not at all", async () => {
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_done")),
      listed("ctx_done", "ready"),
      stopped("ctx_done"),
    ]);
    writeFile();
    const first = await metaSeat(deps(orca, { log })).run(request());
    orca.assertDone();
    const file = seatFile(home, seatOpKey(stepKey, 1));
    expect(first).toEqual({ ok: true, file });
    expect(await metaSeat(deps(noCalls())).run(request())).toEqual({
      ok: true,
      file,
    });
  });

  test("a Dispatch settled without its FILE by another reader: the first rerun returns not ok and marks it, the next starts attempt 2", async () => {
    const controller = new AbortController();
    const first = replay(conn, [
      ok("worker-start", started("ctx_gone")),
      listed("ctx_gone", "running"),
      {
        verb: "worker-stop",
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: { code: "busy" } }),
      },
    ]);
    await metaSeat(
      deps(first.orca, {
        log: first.log,
        pause: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    ).run(request(controller.signal));
    await conn.db.settleDispatch("ctx_gone", {
      activity: "settled",
      settlement: "stopped",
      settled_at: at,
      at,
    });
    expect((await metaSeat(deps(noCalls())).run(request())).ok).toBe(false);
    expect(await seatObserved(conn.db, stepKey, 1)).toBe(true);
    const third = replay(conn, [
      ok("worker-start", started("ctx_again")),
      listed("ctx_again", "failed"),
    ]);
    await metaSeat(deps(third.orca, { log: third.log })).run(request());
    third.orca.assertDone();
    expect((await operation(2))?.result_ref).toMatchObject({
      result: { dispatch_id: "ctx_again" },
    });
  });

  test("the wait lists by the worker runtime's Run, so a bound calling terminal does not matter", async () => {
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_bound", "run_bound")),
      listed("ctx_bound", "succeeded", "run_bound"),
    ]);
    writeFile();
    const outcome = await metaSeat(deps(orca, { log })).run(request());
    orca.assertDone();
    expect(outcome.ok).toBe(true);
    expect((await conn.db.getDispatch("ctx_bound"))?.settlement).toBe("done");
  });

  test("a signal that fires during worker-start records the start, then stops and settles it", async () => {
    const controller = new AbortController();
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_mid")),
      stopped("ctx_mid"),
    ]);
    const watched: OrcaPort = {
      ...orca,
      workerStart: async (req) => {
        controller.abort();
        return orca.workerStart(req);
      },
    };
    const outcome = await metaSeat(deps(watched, { log })).run(
      request(controller.signal),
    );
    orca.assertDone();
    expect(outcome.ok).toBe(false);
    expect(await conn.db.getDispatch("ctx_mid")).toMatchObject({
      settlement: "stopped",
    });
  });

  test("a folder write that throws fails the attempt, frees its slot, and the next run starts attempt 2", async () => {
    const blocked = join(home, "file");
    writeFileSync(blocked, "");
    const outcome = await metaSeat(deps(noCalls(), { home: blocked })).run(
      request(),
    );
    expect(outcome.ok).toBe(false);
    expect(await operation(1)).toMatchObject({
      status: "done",
      result_ref: { outcome: "failed" },
    });
    expect(await hostFreeSlots(conn.db, host, 2)).toBe(2);
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_two")),
      listed("ctx_two", "failed"),
    ]);
    await metaSeat(deps(orca, { log })).run(request());
    orca.assertDone();
    expect((await operation(2))?.status).toBe("done");
  });

  test("a throw from worker-start fails the attempt, and the next run starts attempt 2", async () => {
    const thrown: OrcaPort = {
      ...noCalls(),
      workerStart: () => Promise.reject(new Error("spawn exploded")),
    };
    expect((await metaSeat(deps(thrown)).run(request())).ok).toBe(false);
    expect((await operation(1))?.result_ref).toMatchObject({
      outcome: "failed",
    });
    const { orca, log } = replay(conn, [
      ok("worker-start", started("ctx_after")),
      listed("ctx_after", "failed"),
    ]);
    await metaSeat(deps(orca, { log })).run(request());
    orca.assertDone();
  });

  test.each([
    ["confirmed", stopped("ctx_norun"), "stopped"],
    [
      "not confirmed",
      {
        verb: "worker-stop",
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: { code: "busy" } }),
      },
      "busy",
    ],
  ] as const)(
    "a started receipt with no Run id never leaves an open Dispatch (stop %s), and the next run starts attempt 2",
    async (_name, stop, outcomeText) => {
      const { orca, log } = replay(conn, [
        ok("worker-start", started("ctx_norun", null)),
        stop,
      ]);
      const outcome = await metaSeat(deps(orca, { log })).run(request());
      orca.assertDone();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcomeText === "busy")
        expect(outcome.message).toContain(
          "orca orchestration worker-stop --dispatch ctx_norun",
        );
      expect(await conn.db.getDispatch("ctx_norun")).toMatchObject({
        settlement: "stopped",
        activity: "settled",
      });
      const [stopEvent] = await conn.sql<
        { payload: Record<string, unknown> }[]
      >`
        select payload from ledger.event where type = 'stop' and dispatch_id = 'ctx_norun'`;
      expect(JSON.stringify(stopEvent?.payload)).toContain(outcomeText);
      expect(await seatObserved(conn.db, stepKey, 1)).toBe(true);
      const next = replay(conn, [
        ok("worker-start", started("ctx_retry")),
        listed("ctx_retry", "failed"),
      ]);
      await metaSeat(deps(next.orca, { log: next.log })).run(request());
      next.orca.assertDone();
      expect((await operation(2))?.status).toBe("done");
    },
  );

  test("an unknown receipt keeps request.launch and request.host, so the slot stays held", async () => {
    const { orca, log } = replay(conn, [unknownReply("worker-start", "req-1")]);
    expect((await metaSeat(deps(orca, { log })).run(request())).ok).toBe(false);
    expect(await operation(1)).toMatchObject({
      status: "unknown",
      result_ref: { requestId: "req-1", request: { host, launch: true } },
    });
    expect(await hostFreeSlots(conn.db, host, 2)).toBe(1);
    expect(existsSync(join(home, "meta"))).toBe(true);
  });
});
