import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { renderTemplate, Templates } from "../../src/core/decide/templates.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate, type RunCreateInput } from "../../src/core/run/create.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import {
  decisionCrew,
  planProcess,
  refusedReply,
  seatStarted,
  seedDecision,
} from "./decision-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { replay } from "./run-fixture.ts";
import { activeRevision } from "./seed.ts";

const pairProcess = {
  ...planProcess,
  selector: { stage: "impl", size: ["m", "xl"] },
};

const runStart: TempEntry[] = [
  ok("run-create", { run: { id: "run_1" } }),
  ok("task-create", { task: { id: "task_plan", status: "ready" } }),
  ok("task-create", { task: { id: "task_impl", status: "pending" } }),
];

const seatEntries = (role: "decider" | "auditor"): TempEntry[] => [
  ok("task-create", { task: { id: `orca_${role}`, status: "ready" } }, [
    "--run",
    "run_1",
    "--task-title",
    `decision ${role}`,
  ]),
  ok("worker-start", seatStarted(`ctx_${role}`), ["--task", `orca_${role}`]),
];

describeDb("pod run create opens the coordinator pair for xl", () => {
  let conn: Connection;
  let templates: Revision;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    templates = await seedDecision(conn, { gates: [] }, decisionCrew);
    await activeRevision(conn.db, "process", "pair", pairProcess);
  });
  afterAll(() => conn.close());

  function input(over: Partial<RunCreateInput> = {}): RunCreateInput {
    return {
      story: "S-9",
      process: { name: "pair", rev: 1 },
      size: "xl",
      stage: "impl",
      coordinator: "session-1",
      host: "local",
      provider: "linear",
      command: "pod run create story:S-9 --process pair@1 --size xl",
      seats: { templates, capacity: 2 },
      now: () => new Date(),
      ...over,
    };
  }

  async function create(orca: OrcaPort, over: Partial<RunCreateInput> = {}) {
    return runCreate(
      conn.db,
      orca,
      null,
      receiptLog(conn.db, "local"),
      input(over),
    );
  }

  async function seatOps() {
    return conn.sql<
      {
        status: string;
        role: string;
        decision_id: string | null;
        spec: string;
      }[]
    >`
      select status, result_ref -> 'request' ->> 'role' as role,
        result_ref -> 'request' ->> 'decision_id' as decision_id,
        result_ref ->> 'spec' as spec
      from ledger.operation where intent = 'decide_seat' order by created_at`;
  }

  test("an xl Run opens the decider, then the auditor, after its Tasks, and records the decider as coordinator", async () => {
    const { orca } = replay(conn, [
      ...runStart,
      ...seatEntries("decider"),
      ...seatEntries("auditor"),
    ]);
    const outcome = await create(orca);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "active",
        coordinator_dispatch_id: "ctx_decider",
        auditor_dispatch_id: "ctx_auditor",
      },
    });
    expect(await conn.db.getRun("run_1")).toMatchObject({
      coordinator_dispatch_id: "ctx_decider",
      coordinator: "term_ctx_decider",
      state: "active",
    });
    const ops = await seatOps();
    expect(ops.map((op) => [op.role, op.status, op.decision_id])).toEqual([
      ["decider", "done", null],
      ["auditor", "done", null],
    ]);
    const text = Templates.parse(templates.value).coordinator_open ?? "";
    expect(ops[0]?.spec).toBe(
      renderTemplate(text, {
        story: "story:S-9",
        process: "process.pair@1",
        run_id: "run_1",
        generation: "1",
        check: "pod check --run run_1 --generation 1",
        view_path: "",
      }),
    );
    expect((await conn.db.getDispatch("ctx_auditor"))?.activity).toBe(
      "waiting",
    );
    expect((await conn.db.getDispatch("ctx_decider"))?.activity).toBe(
      "running",
    );
    for (const [index, id] of ["ctx_decider", "ctx_auditor"].entries())
      expect((await conn.db.getDispatch(id))?.prompt_bytes).toBe(
        Buffer.byteLength(ops[index]?.spec ?? "", "utf8"),
      );
    expect(
      (await conn.db.getDispatch("ctx_decider"))?.prompt_bytes,
    ).toBeGreaterThan(0);
    const [created] = await conn.sql<{ result_ref: unknown }[]>`
      select result_ref from ledger.operation where intent = 'run_create'`;
    expect(created?.result_ref).toEqual({
      run_id: "run_1",
      created_by: "session-1",
    });
  });

  test("at capacity 1 the auditor opens in the decider's slot", async () => {
    const { orca } = replay(conn, [
      ...runStart,
      ...seatEntries("decider"),
      ...seatEntries("auditor"),
    ]);
    const outcome = await create(orca, { seats: { templates, capacity: 1 } });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        coordinator_dispatch_id: "ctx_decider",
        auditor_dispatch_id: "ctx_auditor",
      },
    });
    expect((await conn.db.getDispatch("ctx_decider"))?.activity).toBe(
      "running",
    );
  });

  test("an m Run opens no Seat and has no coordinator Dispatch", async () => {
    const { orca } = replay(conn, runStart);
    const outcome = await create(orca, { size: "m" });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { state: "active", coordinator_dispatch_id: null },
    });
    expect(await seatOps()).toEqual([]);
  });

  test("a refused decider leaves the Run on hold with no coordinator Dispatch, and a rerun returns the same result", async () => {
    const { orca } = replay(conn, [
      ...runStart,
      seatEntries("decider")[0]!,
      refusedReply("worker-start", "agent_not_found", [
        "--task",
        "orca_decider",
      ]),
    ]);
    const outcome = await create(orca);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "hold",
        coordinator_dispatch_id: null,
        auditor_dispatch_id: null,
        seat_refusal: { role: "decider", code: "failed" },
      },
    });
    expect((await seatOps()).map((op) => op.role)).toEqual(["decider"]);
    const holds = await conn.sql<{ payload: unknown }[]>`
      select payload from ledger.event where type = 'hold' and task_id is null`;
    expect(holds.map((row) => row.payload)).toEqual([
      { reason: "seat_open", role: "decider", code: "failed", from: "active" },
    ]);
    const again = await create(noCalls());
    expect(again).toEqual(outcome);
  });

  test("a refused auditor leaves the Run on hold with no coordinator Dispatch and the decider running", async () => {
    const { orca } = replay(conn, [
      ...runStart,
      ...seatEntries("decider"),
      seatEntries("auditor")[0]!,
      refusedReply("worker-start", "agent_not_found", [
        "--task",
        "orca_auditor",
      ]),
    ]);
    const outcome = await create(orca);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "hold",
        coordinator_dispatch_id: null,
        seat_refusal: { role: "auditor" },
      },
    });
    expect(await conn.db.getRun("run_1")).toMatchObject({
      state: "hold",
      coordinator_dispatch_id: null,
    });
    expect((await conn.db.getDispatch("ctx_decider"))?.activity).toBe(
      "running",
    );
  });
});
