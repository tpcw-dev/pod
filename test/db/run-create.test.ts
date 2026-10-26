import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCreate, type RunCreateInput } from "../../src/core/run/create.ts";
import {
  fixtures,
  lost,
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { activeRevision, seedConfig } from "./seed.ts";

const requestId = "33333333-3333-4333-8333-333333333333";

const input: RunCreateInput = {
  story: "S-1",
  process: { name: "impl", rev: 1 },
  size: "s",
  stage: "impl",
  coordinator: "session-1",
  host: "local",
  provider: "linear",
  command: "pod run create story:S-1 --process impl@1 --size s --stage impl",
  now: () => new Date(),
};

const happy: TempEntry[] = [
  ok("run-create", { run: { id: "run_1" } }),
  ok("task-create", { task: { id: "task_b", status: "ready" } }, [
    "--run",
    "run_1",
  ]),
  ok("task-create", { task: { id: "task_r", status: "pending" } }, [
    "--run",
    "run_1",
    "--deps",
    '["task_b"]',
  ]),
];

describeDb("pod run create", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });

  beforeEach(async () => {
    await clearDb(conn);
    await seedConfig(conn.db);
  });
  afterAll(() => conn.close());

  function replay(entries: readonly TempEntry[]) {
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({ dir: fixtures(entries), sink: log.sink });
    return { orca, log };
  }

  async function create(
    orca: OrcaPort,
    log = receiptLog(conn.db, "local"),
    over: Partial<RunCreateInput> = {},
  ) {
    return runCreate(conn.db, orca, log, { ...input, ...over });
  }

  async function events(type: string) {
    const rows = await conn.sql<
      { type: string; source: unknown; run_id: string | null }[]
    >`
      select type, source, run_id from ledger.event where type = ${type} order by id`;
    return rows;
  }

  test("pins a Snapshot, creates the Run and one Task per step, and returns owner generation 1", async () => {
    const { orca, log } = replay(happy);
    const outcome = await create(orca, log);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      orca: "1.4.211",
      result: {
        run_id: "run_1",
        story: "story:S-1",
        process: "process.impl@1",
        owner_generation: 1,
        tasks: [
          {
            task_id: "task_b",
            step_id: "build",
            role: "developer",
            state: "ready",
          },
          {
            task_id: "task_r",
            step_id: "review",
            role: "reviewer",
            state: "pending",
          },
        ],
      },
    });
    const run = await conn.db.getRun("run_1");
    expect(run).toMatchObject({
      owner_generation: 1,
      state: "active",
      coordinator: "session-1",
    });
    const snapshot = await conn.db.getSnapshot("run_1");
    expect(snapshot?.hash).toBe(run?.snapshot_hash);
    expect(snapshot?.effective_gate_map).toEqual({});
    expect((await conn.db.getStory("linear", "S-1"))?.run_id).toBe("run_1");
    expect(await conn.db.getTask("task_r")).toMatchObject({
      lineage_id: "run_1:review",
      deps: ["task_b"],
      spec_revision_id: snapshot?.process_revision_id,
    });
    const receipts = await events("receipt");
    expect(receipts.map((row) => row.source)).toEqual([
      { kind: "receipt", verb: "run-create" },
      { kind: "receipt", verb: "task-create" },
      { kind: "receipt", verb: "task-create" },
    ]);
    expect(
      (await conn.sql`select type from ledger.event where type <> 'receipt'`)
        .length,
    ).toBe(0);
  });

  test("a second call for the same Story returns the recorded result with no Orca call", async () => {
    const first = replay(happy);
    const one = await create(first.orca, first.log);
    const two = await create(noCalls());
    expect(two).toEqual(one);
  });

  test("a second call naming another process is selector_conflict and projects nothing", async () => {
    const first = replay(happy);
    expect((await create(first.orca, first.log)).ok).toBe(true);
    await activeRevision(conn.db, "process", "other", {
      steps: [{ id: "solo", role: "developer" }],
    });
    const outcome = await create(noCalls(), undefined, {
      process: { name: "other", rev: 1 },
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_conflict",
        message: "Run run_1 pins process.impl@1, not process.other@1",
      },
    });
    expect(await conn.db.listTasks("run_1")).toHaveLength(2);
  });

  test("a missing --process, size, or stage is selector_none", async () => {
    for (const over of [{ process: null }, { size: null }, { stage: null }]) {
      const outcome = await create(noCalls(), undefined, over);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "selector_none" },
      });
    }
    const outcome = await create(noCalls(), undefined, { process: null });
    expect(outcome).toMatchObject({
      refusal: { nextSteps: [expect.stringContaining("--process")] },
    });
  });

  test("a ref with no process Revision is revision_not_found", async () => {
    const outcome = await create(noCalls(), undefined, {
      process: { name: "impl", rev: 9 },
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "revision_not_found" },
    });
  });

  test("two active global crews is selector_none naming the kind", async () => {
    await activeRevision(conn.db, "crew", "second", { seats: [] });
    const outcome = await create(noCalls());
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_none",
        message: expect.stringContaining("crew"),
      },
    });
  });

  test("a bad step is schema_invalid naming the path, before any Orca call", async () => {
    await activeRevision(conn.db, "process", "broken", {
      steps: [{ id: "a", role: "developer", deps: ["a"] }],
    });
    const outcome = await create(noCalls(), undefined, {
      process: { name: "broken", rev: 1 },
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "schema_invalid", nextSteps: ["steps: cycle a -> a"] },
    });
    expect((await conn.sql`select 1 from ledger.operation`).length).toBe(0);
  });

  test("a lost run-create reply leaves the operation unknown, and a rerun asks request-show", async () => {
    const lostReply = replay([unknownReply("run-create", requestId)]);
    const outcome = await create(lostReply.orca, lostReply.log);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        nextSteps: [input.command, "pod check"],
      },
    });
    const [op] = await conn.sql<{ status: string; result_ref: unknown }[]>`
      select status, result_ref from ledger.operation where intent = 'run_create'`;
    expect(op).toEqual({
      status: "unknown",
      result_ref: { verb: "run-create", requestId },
    });
    const show = replay([
      ok("request-show", { requestId, state: "pending" }, [
        "--request",
        requestId,
      ]),
    ]);
    const again = await create(show.orca, show.log);
    show.orca.assertDone();
    expect(again).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        message: expect.stringContaining("pending"),
      },
    });
  });

  test("a lost task-create reply moves the Run to hold with a hold event", async () => {
    const { orca, log } = replay([happy[0] as TempEntry, lost("task-create")]);
    const outcome = await create(orca, log);
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    const holds = await events("hold");
    expect(holds).toEqual([
      {
        type: "hold",
        source: { kind: "command", verb: "run create" },
        run_id: "run_1",
      },
    ]);
    const again = await create(noCalls());
    expect(again).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        message: expect.stringContaining("no request id"),
      },
    });
  });

  test("the CLI prints ownerGeneration in meta and needs POD_COORDINATOR", () => {
    const args = [
      "run",
      "create",
      "story:S-1",
      "--process",
      "impl@1",
      "--size",
      "s",
      "--stage",
      "impl",
    ];
    const unset = runCli(args, {
      POD_COORDINATOR: "",
      POD_ORCA_FIXTURES: fixtures(happy),
    });
    expect(unset.status).toBe(2);
    expect(unset.json.error?.code).toBe("usage");
    const record = runCli(args, {
      POD_COORDINATOR: "session-1",
      POD_ORCA_RECORD: fixtures([]),
      POD_SCRUB_DENYLIST: "",
    });
    expect(record.status).toBe(2);
    expect(record.json.error?.message).toBe(
      "POD_ORCA_RECORD needs POD_SCRUB_DENYLIST",
    );
    const result = runCli(args, {
      POD_COORDINATOR: "session-1",
      POD_ORCA_FIXTURES: fixtures(happy),
    });
    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      result: { run_id: "run_1" },
      meta: {
        ownerGeneration: 1,
        orca: "1.4.211",
        opKey: expect.stringMatching(/^run_create:/),
      },
    });
  });
});
