import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { retry } from "../../src/core/dispatch/retry.ts";
import type { Kind } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Dispatch } from "../../src/core/domain/ledger.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import type { NeedsHumanLine } from "../../src/core/domain/tick.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  attend,
  attentionOpKey,
  type AttentionPort,
} from "../../src/core/operate/attention.ts";
import { runTick, type TickOutcome } from "../../src/core/operate/tick.ts";
import { WorkerListResult, type OrcaPort } from "../../src/core/ports/orca.ts";
import { noCalls, ok } from "../orca/temp-fixtures.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { idleSteps, withAttention } from "./operate-ports.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  dispatched,
  events,
  freshRun,
  replay,
  started,
  taskState,
  workers,
  worktreeId,
} from "./run-fixture.ts";
import { seedHost } from "./seed.ts";

const gitStatus = "## main...origin/main";
const retryArgv = [
  "--task",
  "task_b",
  "--run",
  "run_1",
  "--agent",
  "claude",
  "--model",
  "m-1",
  "--effort",
  "low",
  "--worktree",
  `id:${worktreeId}`,
  "--retry-of",
  "ctx_1",
];

type Row = { dispatchId: string; workerState: string; terminalState?: string };

describeDb("pod tick attention: stalls and the one automatic retry", () => {
  let conn: Connection;
  let now: Date;
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await seedHost(conn.db);
    await activate("schedule", "default", {
      tick_minutes: 15,
      hold_minutes: 60,
    });
    now = new Date();
  });
  afterAll(() => conn.close());

  async function activate(kind: Kind, name: string, value: Json) {
    const revision = await storeRevision(conn.db, {
      ...envelope(kind, name, value),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind,
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date(),
    });
    if (!activated.ok) throw new Error(`${kind} not activated`);
  }

  function port(
    rows: Row[] | null,
    orca: OrcaPort = noCalls(),
    capacity = 2,
  ): AttentionPort & { started: string[] } {
    const log = receiptLog(conn.db, "local");
    const startedFor: string[] = [];
    return {
      started: startedFor,
      capacity,
      workers: () =>
        Promise.resolve(
          rows === null ? null : WorkerListResult.parse(workers(rows)).workers,
        ),
      retry(dispatch: Dispatch, opKey: string) {
        startedFor.push(dispatch.dispatch_id);
        return retry(conn.db, orca, log, {
          dispatch: dispatch.dispatch_id,
          generation: 1,
          opKey,
          host: "local",
          capacity,
          gitStatus,
          command: (key) => `pod retry --dispatch ctx_1 --op-key ${key}`,
          now: () => new Date(),
        });
      },
    };
  }

  async function lines(
    at: Date,
    rows: Row[] | null = [],
    attention: AttentionPort = port(rows),
  ): Promise<NeedsHumanLine[]> {
    const result = await attend(conn.db, attention, {
      host: "local",
      writer: "local",
      now: at,
    });
    return result.needs_human ?? [];
  }

  const kinds = (found: NeedsHumanLine[]) =>
    found.map(
      (line) =>
        `${line.kind} ${line.dispatch_id ?? line.task_id ?? line.decision_id ?? line.run_id}`,
    );

  async function dispatchedAt(dispatchId: string, at: Date) {
    await dispatched(conn, dispatchId);
    await conn.sql`update ledger.dispatch set created_at = ${at.toISOString()} where dispatch_id = ${dispatchId}`;
  }

  function ran(outcome: TickOutcome | Refused): TickOutcome {
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome;
  }

  async function opRow(opKey: string) {
    return conn.db.getOperation(opKey);
  }

  async function decision(
    id: string,
    state: string,
    reason: string | null,
    createdAt: Date,
  ) {
    await conn.db.insertManifest({
      id: `man_${id}`,
      run_id: "run_1",
      task_id: null,
      decision_id: null,
      parent_id: null,
      references: [],
      tests: null,
      created_at: createdAt,
    });
    await conn.db.insertDecision({
      id,
      run_id: "run_1",
      task_id: null,
      category: "plan",
      effect: "accept_plan",
      question: "q",
      options: [],
      manifest_id: `man_${id}`,
      state,
      outcome: null,
      reason,
      binding: "run",
      budget: {},
      spent: {},
      supersedes_decision_id: null,
      adoption: "pending",
      adoption_evidence: [],
      created_at: createdAt,
      closed_at: null,
    });
  }

  test("a running Dispatch with no delivery is a line only past stall_minutes", async () => {
    await dispatchedAt("ctx_1", minutes(-30));
    const live = [{ dispatchId: "ctx_1", workerState: "ready" }];
    expect(kinds(await lines(now, live))).not.toContain(
      "dispatch_silent ctx_1",
    );
    expect(kinds(await lines(minutes(1), live))).toContain(
      "dispatch_silent ctx_1",
    );
  });

  test("a ready Task with no Dispatch is a line at once, and a pending Task is not", async () => {
    const found = kinds(await lines(now));
    expect(found).toContain("task_unlaunched task_b");
    expect(found.join(" ")).not.toContain("task_r");
  });

  test("a Run in hold is a line", async () => {
    expect(kinds(await lines(now))).not.toContain("run_hold run_1");
    await conn.sql`update ledger.run set state = 'hold' where run_id = 'run_1'`;
    expect(kinds(await lines(now))).toContain("run_hold run_1");
  });

  test("an open Decision past its wall_clock budget is a line, and one inside it is not", async () => {
    await decision("dec_old", "round:1", null, minutes(-121));
    await decision("dec_new", "round:1", null, minutes(-5));
    const found = kinds(await lines(now));
    expect(found).toContain("decision_over_budget dec_old");
    expect(found).not.toContain("decision_over_budget dec_new");
  });

  test("a needs_human Decision is a line", async () => {
    await decision("dec_1", "needs_human", "disagreement", now);
    const found = await lines(now);
    expect(kinds(found)).toContain("decision_needs_human dec_1");
    expect(found.find((line) => line.decision_id === "dec_1")?.text).toContain(
      "disagreement",
    );
  });

  test("a stopped worker is settled as pod check settles it, then retried with one worker-start", async () => {
    await dispatchedAt("ctx_1", minutes(-5));
    const { orca } = replay(conn, [
      ok("worker-start", started("ctx_2"), retryArgv),
    ]);
    const attention = port(
      [{ dispatchId: "ctx_1", workerState: "stopped" }],
      orca,
    );
    const result = await attend(conn.db, attention, {
      host: "local",
      writer: "local",
      now,
    });
    orca.assertDone();
    expect(result.detail).toMatchObject({
      retried: [
        {
          dispatch_id: "ctx_1",
          op_key: attentionOpKey("local", "ctx_1", "S-1"),
          ok: true,
          code: null,
        },
      ],
      unread: [],
    });
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      settlement: "stopped",
      activity: "settled",
    });
    expect(await events(conn, "stop")).toEqual([
      expect.objectContaining({ dispatch_id: "ctx_1" }),
    ]);
    expect(await conn.db.getDispatch("ctx_2")).toMatchObject({
      retry_of: "ctx_1",
    });
    expect(await taskState(conn, "task_b")).toBe("dispatched");
    expect(kinds(result.needs_human ?? []).join(" ")).not.toContain("ctx_1");
    expect(await events(conn, "takeover")).toEqual([]);
  });

  test("an abandoned worker is neither settled nor retried by the tick", async () => {
    await dispatchedAt("ctx_1", minutes(-5));
    const attention = port([
      {
        dispatchId: "ctx_1",
        workerState: "abandoned",
        terminalState: "released",
      },
    ]);
    const result = await attend(conn.db, attention, {
      host: "local",
      writer: "local",
      now,
    });
    expect(attention.started).toEqual([]);
    expect(result.detail).toMatchObject({ retried: [] });
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      settlement: "open",
    });
    expect(await events(conn, "stop")).toEqual([]);
    expect(await taskState(conn, "task_b")).toBe("dispatched");
  });

  test("a crash after worker-start and a re-run of the tick start no second worker", async () => {
    await dispatchedAt("ctx_1", minutes(-5));
    const { orca } = replay(conn, [
      ok("worker-start", started("ctx_2"), retryArgv),
    ]);
    const stopped = [{ dispatchId: "ctx_1", workerState: "stopped" }];
    await attend(conn.db, port(stopped, orca), {
      host: "local",
      writer: "local",
      now,
    });
    orca.assertDone();
    const rows = [...stopped, { dispatchId: "ctx_2", workerState: "ready" }];
    const tick = ran(
      await runTick(
        conn.db,
        {
          host: "local",
          writer: "local",
          actor: "person:human",
          now,
          triggers: [],
        },
        withAttention(idleSteps(conn.db), port(rows)),
      ),
    );
    const attention = tick.steps.find((each) => each.step === "attention");
    expect(attention?.result).toBe("ok");
    expect(attention?.detail).toMatchObject({
      retried: [{ dispatch_id: "ctx_1", ok: true }],
    });
    const again = ran(
      await runTick(
        conn.db,
        {
          host: "local",
          writer: "local",
          actor: "person:human",
          now: minutes(16),
          triggers: [],
        },
        withAttention(idleSteps(conn.db), port(rows)),
      ),
    );
    expect(again.outcome).toBe("ran");
    expect(
      (
        await conn.sql`select count(*)::int as n from ledger.dispatch where retry_of = 'ctx_1'`
      )[0],
    ).toEqual({ n: 1 });
  });

  test("a stopped retry is a worker_ended line and is not retried again", async () => {
    await dispatchedAt("ctx_1", minutes(-5));
    const { orca } = replay(conn, [
      ok("worker-start", started("ctx_2"), retryArgv),
    ]);
    await attend(
      conn.db,
      port([{ dispatchId: "ctx_1", workerState: "stopped" }], orca),
      { host: "local", writer: "local", now },
    );
    const both = [
      { dispatchId: "ctx_1", workerState: "stopped" },
      { dispatchId: "ctx_2", workerState: "stopped" },
    ];
    const attention = port(both);
    const found = await lines(minutes(1), both, attention);
    expect(attention.started).toEqual([]);
    expect(found.find((line) => line.dispatch_id === "ctx_2")).toMatchObject({
      kind: "worker_ended",
      text: expect.stringContaining("is itself the retry of ctx_1"),
    });
  });

  test("a succeeded worker with no delivery is a worker_ended line, with no retry and no dispatch_silent line", async () => {
    await dispatchedAt("ctx_1", minutes(-45));
    const rows = [{ dispatchId: "ctx_1", workerState: "succeeded" }];
    const attention = port(rows);
    const found = await lines(now, rows, attention);
    expect(attention.started).toEqual([]);
    expect(found.filter((line) => line.dispatch_id === "ctx_1")).toEqual([
      expect.objectContaining({
        kind: "worker_ended",
        text: "Dispatch ctx_1 worker succeeded with no delivery recorded; pod check has its report to read",
      }),
    ]);
    expect(await conn.db.getDispatch("ctx_1")).toMatchObject({
      settlement: "open",
    });
  });

  test("an unread worker list keeps the ledger lines and retries nothing", async () => {
    await dispatchedAt("ctx_1", minutes(-45));
    const attention = port(null);
    const result = await attend(conn.db, attention, {
      host: "local",
      writer: "local",
      now,
    });
    expect(attention.started).toEqual([]);
    expect(result.detail).toMatchObject({ unread: ["run_1"] });
    expect(kinds(result.needs_human ?? [])).toContain("dispatch_silent ctx_1");
  });

  test("a full host stores no retry, and the next tick with a free slot retries once", async () => {
    await dispatchedAt("ctx_1", minutes(-5));
    const stopped = [{ dispatchId: "ctx_1", workerState: "stopped" }];
    const full = port(stopped, noCalls(), 0);
    const first = await lines(now, stopped, full);
    expect(full.started).toEqual([]);
    expect(first.find((line) => line.dispatch_id === "ctx_1")).toMatchObject({
      kind: "worker_ended",
      text: expect.stringContaining("quota_exhausted"),
    });
    expect(await opRow(attentionOpKey("local", "ctx_1", "S-1"))).toBeNull();
    const { orca } = replay(conn, [
      ok("worker-start", started("ctx_2"), retryArgv),
    ]);
    const free = port(stopped, orca);
    await lines(minutes(1), stopped, free);
    orca.assertDone();
    expect(free.started).toEqual(["ctx_1"]);
  });

  test("a Dispatch started on another host is not retried", async () => {
    await dispatched(conn, "ctx_1", { host: "other" });
    const stopped = [{ dispatchId: "ctx_1", workerState: "stopped" }];
    const attention = port(stopped);
    const found = await lines(now, stopped, attention);
    expect(attention.started).toEqual([]);
    expect(found.find((line) => line.dispatch_id === "ctx_1")).toMatchObject({
      kind: "worker_ended",
      text: expect.stringContaining("task_not_ready"),
    });
    expect(await opRow(attentionOpKey("local", "ctx_1", "S-1"))).toBeNull();
  });

  test("a Dispatch Pod settled as superseded is neither a line nor retried", async () => {
    await dispatchedAt("ctx_1", minutes(-45));
    await conn.sql`
      update ledger.dispatch set activity = 'settled', settlement = 'superseded', settled_at = now()
      where dispatch_id = 'ctx_1'`;
    const stopped = [{ dispatchId: "ctx_1", workerState: "stopped" }];
    const attention = port(stopped);
    const found = await lines(now, stopped, attention);
    expect(attention.started).toEqual([]);
    expect(found.filter((line) => line.dispatch_id === "ctx_1")).toEqual([]);
  });

  test("lines come out in the replay order", async () => {
    await decision("dec_b", "needs_human", "disagreement", now);
    await decision("dec_a", "needs_human", "disagreement", now);
    await conn.sql`update ledger.run set state = 'hold' where run_id = 'run_1'`;
    const found = await lines(now);
    expect(found.map((line) => [line.kind, line.decision_id])).toEqual([
      ["decision_needs_human", "dec_a"],
      ["decision_needs_human", "dec_b"],
      ["run_hold", null],
      ["task_unlaunched", null],
    ]);
  });
});
