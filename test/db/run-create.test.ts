import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse } from "yaml";
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
import { fakeTracker, trackerStory } from "./fake-tracker.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { activeRevision, processValue, seedConfig } from "./seed.ts";

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
    return runCreate(conn.db, orca, null, log, { ...input, ...over });
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

  test("an xl Story selects impl-xlarge, projects the plan Task ready, and the brief waits on decision plan", async () => {
    const xl = parse(
      readFileSync("specs/process/impl-xlarge.yaml", "utf8"),
    ) as { value: Parameters<typeof activeRevision>[3] };
    await activeRevision(conn.db, "process", "impl-xlarge", xl.value);
    const steps = [
      "plan",
      "implement",
      "review",
      "integration_review",
      "pr",
      "merge",
      "deploy",
      "hqa",
    ];
    const { orca, log } = replay([
      ok("run-create", { run: { id: "run_xl" } }),
      ...steps.map((step, i) =>
        ok(
          "task-create",
          {
            task: { id: `task_${step}`, status: i === 0 ? "ready" : "pending" },
          },
          ["--run", "run_xl"],
        ),
      ),
    ]);
    const outcome = await create(orca, log, {
      story: "S-XL",
      process: null,
      size: "xl",
      command: "pod run create story:S-XL --size xl --stage impl",
    });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { run_id: "run_xl", process: "process.impl-xlarge@1" },
    });
    expect(await conn.db.getTask("task_plan")).toMatchObject({
      step_id: "plan",
      role: "planner",
      state: "ready",
    });
    const brief = runCli(["brief", "story:S-XL"]);
    expect(brief.status).toBe(0);
    const [story] = brief.json.result?.["stories"] as {
      runs: { tasks: { step_id: string; waiting_on: string | null }[] }[];
    }[];
    expect(
      Object.fromEntries(
        story?.runs[0]?.tasks.map((task) => [task.step_id, task.waiting_on]) ??
          [],
      ),
    ).toEqual({
      plan: "decision plan",
      implement: null,
      review: "gate review",
      integration_review: "gate integration_review",
      pr: null,
      merge: "gate merge",
      deploy: null,
      hqa: "gate hqa_after_deploy",
    });
  });

  test("with a tracker, the Story supplies size, stage, and the Kickoff process with no flags", async () => {
    const { orca, log } = replay(happy);
    const tracker = fakeTracker(
      trackerStory({
        title: "Build it",
        size: "xs",
        stageLabel: "impl",
        kickoffLine: { name: "impl", rev: 1 },
        kickoffText: "Kickoff: impl@1",
        status: "Todo",
        statusType: "unstarted",
      }),
    );
    const outcome = await runCreate(conn.db, orca, tracker, log, {
      ...input,
      process: null,
      size: null,
      stage: null,
      command: "pod run create story:S-1",
    });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { run_id: "run_1", process: "process.impl@1" },
    });
    expect(tracker.calls).toEqual(["readStory"]);
    expect(await conn.db.getStory("linear", "S-1")).toMatchObject({
      size: "xs",
      stage: "impl",
      run_id: "run_1",
      status: "Todo",
      title: "Build it",
      kickoff_line: "Kickoff: impl@1",
    });
  });

  test("with a tracker, --size overrides the tracker's estimate", async () => {
    const { orca, log } = replay(happy);
    const tracker = fakeTracker(trackerStory({ size: "xl" }));
    const outcome = await runCreate(conn.db, orca, tracker, log, {
      ...input,
      process: null,
      size: "s",
      stage: null,
    });
    expect(outcome.ok).toBe(true);
    expect((await conn.db.getStory("linear", "S-1"))?.size).toBe("s");
  });

  test("with a tracker, a Story with no estimate refuses selector_none naming the size", async () => {
    const tracker = fakeTracker(trackerStory({ size: null }));
    expect(
      await runCreate(
        conn.db,
        noCalls(),
        tracker,
        receiptLog(conn.db, "local"),
        {
          ...input,
          size: null,
        },
      ),
    ).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_none",
        message: "story:S-1 has no size",
        nextSteps: ["--size xs|s|m|l|xl"],
      },
    });
  });

  test("with a tracker, a Kickoff line that differs from --process refuses selector_conflict", async () => {
    const tracker = fakeTracker(
      trackerStory({ kickoffLine: { name: "impl", rev: 2 } }),
    );
    const outcome = await runCreate(
      conn.db,
      noCalls(),
      tracker,
      receiptLog(conn.db, "local"),
      input,
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "selector_conflict" },
    });
  });

  test("with a tracker, a Story the tracker does not have refuses story_not_found", async () => {
    const tracker = fakeTracker(
      trackerStory({ ref: { provider: "linear", external_id: "OTHER" } }),
    );
    expect(
      await runCreate(
        conn.db,
        noCalls(),
        tracker,
        receiptLog(conn.db, "local"),
        input,
      ),
    ).toMatchObject({ ok: false, refusal: { code: "story_not_found" } });
    expect(await conn.db.getStory("linear", "S-1")).toBeNull();
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
      ...processValue,
      summary: "other",
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

  test("a missing size or stage is selector_none", async () => {
    for (const over of [{ size: null }, { stage: null }]) {
      const outcome = await create(noCalls(), undefined, over);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "selector_none" },
      });
    }
  });

  test("no --process selects the single matching activation and pins it", async () => {
    const { orca, log } = replay(happy);
    const outcome = await create(orca, log, { process: null });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: { process: "process.impl@1" },
    });
    const snapshot = await conn.db.getSnapshot("run_1");
    const pinned = await conn.db.getRevisionByRef("process", "impl", 1);
    expect(snapshot?.process_revision_id).toBe(pinned?.id);
  });

  test("a second activation with the same selector is selector_many naming both", async () => {
    await activeRevision(conn.db, "process", "twin", {
      ...processValue,
      summary: "twin",
    });
    const outcome = await create(noCalls(), undefined, { process: null });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_many",
        message: expect.stringMatching(
          /stage impl, size s: .*process\.impl@1.*process\.twin@1|stage impl, size s: .*process\.twin@1.*process\.impl@1/,
        ),
        nextSteps: expect.arrayContaining([
          "--process name@rev",
          "--process impl@1",
          "--process twin@1",
        ]),
      },
    });
    expect((await conn.sql`select 1 from ledger.operation`).length).toBe(0);
  });

  test("no matching activation is selector_none naming --process", async () => {
    const outcome = await create(noCalls(), undefined, {
      process: null,
      stage: "prd",
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_none",
        message: expect.stringContaining("stage prd, size s"),
        nextSteps: ["--process name@rev"],
      },
    });
  });

  test("--process impl@1 with --size m is selector_conflict", async () => {
    const outcome = await create(noCalls(), undefined, { size: "m" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "selector_conflict",
        message: "process.impl@1 does not fit stage impl, size m",
      },
    });
    expect((await conn.sql`select 1 from ledger.operation`).length).toBe(0);
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
      ...processValue,
      steps: [{ id: "a", type: "worker", role: "developer", needs: ["a"] }],
      edges: [],
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
    const [payload] =
      await conn.sql`select payload from ledger.event where type = 'hold'`;
    expect(payload?.["payload"]).toMatchObject({
      reason: "launch_unknown",
      from: "active",
    });
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
