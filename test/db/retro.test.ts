import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Finding } from "../../src/core/domain/retro.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { retroRecord } from "../../src/core/retro/record.ts";
import { retroRun, type RetroRunInput } from "../../src/core/retro/run.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { normalizeExpected } from "../../src/core/learning/match.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import {
  createRun,
  dispatchInput,
  events,
  replay,
  started,
} from "./run-fixture.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];
const method = "Read each finding class and quote the transcript line.";

const retroProcess = {
  ...processValue,
  roles: [...processValue.roles, "retro"],
  steps: [
    ...processValue.steps,
    { id: "retro", type: "worker", role: "retro", after: "close", method },
  ],
  edges: [
    ...processValue.edges,
    { from: "retro", on: "done", to: "done" },
    { from: "retro", on: hold, to: "hold" },
  ],
};

const retroCrew = {
  seats: [
    ...crewValue.seats,
    { id: "retro-1", roles: ["retro"], runtime: "claude" },
    { id: "dev-retro", roles: ["developer", "retro"], runtime: "claude" },
  ],
};

const hostValue = {
  driver: "hat-a",
  hostnames: ["local"],
  manager: true,
  slots: { default: 2, max: 3 },
  reserved: {},
  projects: ["*"],
  transcripts: { claude: "/transcripts/{session_id}.jsonl" },
};

let clock = Date.parse("2026-11-11T00:00:00.000Z");
const now = () => new Date((clock += 1000));

let conn: Connection;
let specs: string[];

function recording(entries: readonly TempEntry[]) {
  const { orca, log } = replay(conn, entries);
  const port: OrcaPort = {
    ...orca,
    taskCreate: (request) => {
      specs.push(request.spec);
      return orca.taskCreate(request);
    },
  };
  return { orca, port, log };
}

function withSession(dispatchId: string, taskId: string, sessionId: string) {
  const reply = started(dispatchId, taskId) as {
    launch: { effective: Record<string, unknown> };
  };
  return {
    ...reply,
    launch: {
      ...reply.launch,
      effective: { ...reply.launch.effective, sessionId },
    },
  };
}

async function activateHost(value: Json) {
  const revision = await storeRevision(conn.db, {
    ...envelope("host", "local", value),
    scope: "host",
    scope_ref: "local",
  });
  await conn.db.activate({
    scope: "host",
    scope_ref: "local",
    kind: "host",
    name: "local",
    expected: null,
    revision_id: revision.id,
    bundle_id: null,
    activated_by: "operator",
    activated_at: now(),
  });
}

async function launch(taskId: string, seat: string, reply: unknown) {
  const { orca, log } = replay(conn, [ok("worker-start", reply)]);
  const outcome = await dispatch(
    conn.db,
    orca,
    log,
    dispatchInput({ task: taskId, seat, capacity: 10 }),
  );
  if (!outcome.ok) throw new Error(outcome.refusal.message);
}

async function launchBefore(taskId: string, seat: string, reply: unknown) {
  await conn.db.setRunState("run_1", "active");
  await conn.db.setTaskState(taskId, "ready");
  await launch(taskId, seat, reply);
  await conn.db.setTaskState(taskId, "done");
  await conn.db.setRunState("run_1", "done");
}

async function seed(kinds: string[] = ["lead", "tech"]) {
  await clearDb(conn);
  specs = [];
  await activeRevision(conn.db, "policy", "default", {
    gates: ["pr"],
    learning: { kinds },
  });
  await activeRevision(conn.db, "crew", "default", retroCrew);
  await activeRevision(conn.db, "process", "impl", retroProcess);
  await activateHost(hostValue);
  await createRun(conn);
  await launch("task_b", "dev-1", withSession("ctx_dev", "task_b", "sess-1"));
  await conn.db.setTaskState("task_b", "done");
  await conn.db.setTaskState("task_r", "ready");
  await launch("task_r", "rev-1", started("ctx_rev", "task_r"));
  await conn.db.setTaskState("task_r", "done");
  await conn.db.appendEvent({
    type: "pr",
    ts: now(),
    host: "local",
    run_id: "run_1",
    task_id: "task_b",
    dispatch_id: "ctx_dev",
    op_key: null,
    payload: { number: 7, url: "https://code.example/pr/7", head: "abc1234" },
    source: { kind: "command", verb: "test" },
  });
}

async function close(retroDue: boolean) {
  await conn.db.setRunState("run_1", "done");
  await conn.db.appendEvent({
    type: "close",
    ts: now(),
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: closeStepKey("run_1", "archive"),
    payload: {
      op_key: closeStepKey("run_1", "archive"),
      retro_due: retroDue,
      worktrees: [
        {
          selector: "id:repo-1::/w/one",
          path: "/w/one",
          repo: "repo-1",
          branch: "feature",
          tip: "abc1234",
        },
      ],
    },
    source: { kind: "command", verb: "run close" },
  });
}

const codeHost = makeFixtureCodeHost({
  prs: [
    {
      number: 7,
      state: "merged",
      head_branch: "feature",
      head_sha: "abc1234",
      merge_commit: "def5678",
    },
  ],
});

function runInput(over: Partial<RetroRunInput> = {}): RetroRunInput {
  return {
    run: "run_1",
    seat: "retro-1",
    generation: 1,
    attempt: "1",
    host: "local",
    capacity: 3,
    codeHost,
    command: "pod retro run:run_1 --seat retro-1 --generation 1",
    now,
    ...over,
  };
}

const retroLaunch = [
  ok("task-create", { task: { id: "task_retro", status: "ready" } }),
  ok("worker-start", started("ctx_retro", "task_retro")),
];

async function runRetro(
  entries: readonly TempEntry[] = retroLaunch,
  over: Partial<RetroRunInput> = {},
) {
  if (entries.length === 0)
    return retroRun(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      runInput(over),
    );
  const { orca, port, log } = recording(entries);
  const outcome = await retroRun(conn.db, port, log, runInput(over));
  orca.assertDone();
  return outcome;
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    text: "the reviewer reran the suite the lead had already run",
    expected: "the reviewer reuses the lead's check output",
    area: "process",
    evidence_refs: ["transcript:ctx_dev:12"],
    wording: "reran the full suite",
    ...over,
  };
}

function record(findings: Finding[]) {
  return retroRecord(conn.db, {
    run: "run_1",
    findings,
    host: "local",
    now,
  });
}

async function operations(intent: string) {
  return conn.sql<{ op_key: string; status: string }[]>`
    select op_key, status from ledger.operation where intent = ${intent} order by op_key`;
}

describeDb("pod retro", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  describe("a Run that is not due a retro", () => {
    beforeEach(() => seed());

    test("a Run with no close event is refused retro_not_due and writes nothing", async () => {
      const outcome = await runRetro([]);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "retro_not_due" },
      });
      if (!outcome.ok)
        expect(outcome.refusal.nextSteps).toEqual([
          "pod run close story:S-1 --generation 1",
        ]);
      expect(await operations("retro")).toEqual([]);
      expect(await events(conn, "retro")).toEqual([]);
      expect(await conn.db.listTasks("run_1")).toHaveLength(2);
    });

    test("a close with retro_due false is refused retro_not_due, and record writes no learning", async () => {
      await close(false);
      expect(await runRetro([])).toMatchObject({
        ok: false,
        refusal: { code: "retro_not_due" },
      });
      expect(await record([finding()])).toMatchObject({
        ok: false,
        refusal: { code: "retro_not_due" },
      });
      expect(await conn.sql`select id from ledger.learning`).toHaveLength(0);
    });
  });

  describe("a Run due a retro", () => {
    beforeEach(async () => {
      await seed();
      await close(true);
    });

    test("dispatches one retro Task whose TASK block carries the Method line and the transcript locators", async () => {
      const outcome = await runRetro();
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          state: "dispatched",
          task_id: "task_retro",
          dispatch_id: "ctx_retro",
          transcripts: [
            {
              dispatch_id: "ctx_dev",
              harness: "claude",
              session_id: "sess-1",
              path: "/transcripts/sess-1.jsonl",
              status: "resolved",
            },
            { dispatch_id: "ctx_rev", status: "absent" },
          ],
        },
      });
      expect(specs).toHaveLength(1);
      const [spec] = specs;
      expect(spec).toContain(`\n\nMethod: ${method}`);
      expect(spec?.endsWith(`Method: ${method}`)).toBe(true);
      expect(spec).toContain(
        "- ctx_dev developer dev-1: /transcripts/sess-1.jsonl",
      );
      expect(spec).toContain(
        "- ctx_rev reviewer rev-1: absent, the launch receipt named no session id",
      );
      expect(spec).toContain("Merged PRs: pr:7 merged def5678");
      expect(spec).toContain("Tracker record: story:S-1 (linear)");
      const tasks = await conn.db.listTasks("run_1");
      expect(tasks.filter((task) => task.step_id === "retro")).toHaveLength(1);
      expect((await conn.db.getRun("run_1"))?.state).toBe("done");
      const rows = await conn.db.listDispatches("run_1");
      expect(rows.map((row) => row.dispatch_id)).toContain("ctx_retro");
    });

    test("the launch record keeps the receipt's session id as a locator and no path", async () => {
      const rows = await conn.db.listDispatches("run_1");
      const dev = rows.find((row) => row.dispatch_id === "ctx_dev");
      const rev = rows.find((row) => row.dispatch_id === "ctx_rev");
      expect(dev?.effective_launch).toMatchObject({
        transcript: { harness: "claude", session_id: "sess-1" },
      });
      expect(JSON.stringify(dev?.effective_launch)).not.toContain(
        "/transcripts/",
      );
      expect(rev?.effective_launch).not.toHaveProperty("transcript");
    });

    test.each(["..", ".", "a/b", "a\\b", ""])(
      "a session id of %j records no locator",
      async (sessionId) => {
        await launchBefore(
          "task_b",
          "both-1",
          withSession("ctx_odd", "task_b", sessionId),
        );
        const row = (await conn.db.listDispatches("run_1")).find(
          (each) => each.dispatch_id === "ctx_odd",
        );
        expect(row?.effective_launch).not.toHaveProperty("transcript");
      },
    );

    test("a stored session id that is not one path segment resolves unresolved", async () => {
      await conn.sql`
        update ledger.dispatch
        set effective_launch = jsonb_set(effective_launch, '{transcript,session_id}', '"../x"')
        where dispatch_id = 'ctx_dev'`;
      const outcome = await runRetro();
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          transcripts: [
            {
              dispatch_id: "ctx_dev",
              session_id: "../x",
              path: null,
              status: "unresolved",
            },
            { dispatch_id: "ctx_rev", status: "absent" },
          ],
        },
      });
      expect(specs[0]).not.toContain("/transcripts/");
    });

    test("a Seat that worked on the Run is refused reviewer_not_independent", async () => {
      await launchBefore("task_b", "dev-retro", started("ctx_dr", "task_b"));
      const outcome = await runRetro(
        [ok("task-create", { task: { id: "task_retro", status: "ready" } })],
        { seat: "dev-retro", capacity: 10 },
      );
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "reviewer_not_independent" },
      });
    });

    test("a refused dispatch names a new --op-key, and a rerun with one launches", async () => {
      await conn.sql`
        update ledger.dispatch set settlement = 'open', activity = 'running'`;
      const full = await runRetro(
        [ok("task-create", { task: { id: "task_retro", status: "ready" } })],
        { capacity: 2 },
      );
      expect(full).toMatchObject({
        ok: false,
        refusal: { code: "quota_exhausted" },
      });
      if (!full.ok)
        expect(full.refusal.nextSteps[0]).toBe(
          "pod retro run:run_1 --seat retro-1 --generation 1 --op-key <new>",
        );
      const again = await runRetro(
        [ok("worker-start", started("ctx_retro", "task_retro"))],
        { attempt: "2" },
      );
      expect(again).toMatchObject({
        ok: true,
        result: { task_id: "task_retro", dispatch_id: "ctx_retro" },
      });
    });

    test("a failed task-create keeps the Run done, and a rerun with a new --op-key creates the Task", async () => {
      const failed = await runRetro([
        { verb: "task-create", exitCode: 1, stdout: "{}" },
      ]);
      expect(failed).toMatchObject({ ok: false, refusal: { code: "failed" } });
      if (!failed.ok)
        expect(failed.refusal.nextSteps[0]).toBe(
          "pod retro run:run_1 --seat retro-1 --generation 1 --op-key <new>",
        );
      expect((await conn.db.getRun("run_1"))?.state).toBe("done");
      expect(await events(conn, "hold")).toEqual([]);
      const again = await runRetro(retroLaunch, { attempt: "2" });
      expect(again).toMatchObject({
        ok: true,
        result: { task_id: "task_retro" },
      });
    });

    test("an unknown task-create returns launch_unknown and keeps the Run done", async () => {
      const lost = await runRetro([unknownReply("task-create", "req-1")]);
      expect(lost).toMatchObject({
        ok: false,
        refusal: { code: "launch_unknown" },
      });
      expect((await conn.db.getRun("run_1"))?.state).toBe("done");
      expect(await events(conn, "hold")).toEqual([]);
      const again = await runRetro(retroLaunch, { attempt: "2" });
      expect(again).toMatchObject({
        ok: true,
        result: { task_id: "task_retro" },
      });
    });

    test("a rerun with the same --op-key replays the dispatch and creates no second Task", async () => {
      await runRetro();
      const again = await runRetro([]);
      expect(again).toMatchObject({
        ok: true,
        result: {
          task_id: "task_retro",
          dispatch_id: "ctx_retro",
          replayed: true,
        },
      });
      const tasks = await conn.db.listTasks("run_1");
      expect(tasks.filter((task) => task.step_id === "retro")).toHaveLength(1);
    });

    test("an active Run's retro Task is refused task_not_ready", async () => {
      await runRetro();
      await conn.db.setRunState("run_1", "active");
      const outcome = await dispatch(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        dispatchInput({
          task: "task_retro",
          seat: "retro-1",
          opKey: "k-active",
        }),
      );
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "task_not_ready" },
      });
    });

    test("retro record sends findings through matching as kind tech, reporter retro, and appends one retro event", async () => {
      await runRetro();
      const outcome = await record([
        finding(),
        finding({
          text: "the design named a CLI shape from memory",
          evidence_refs: ["pr:7"],
          wording: "quoted the CLI from memory",
          expected: undefined,
        }),
      ]);
      expect(outcome).toMatchObject({
        ok: true,
        result: { complete: true, ambiguous: [], replayed: false },
      });
      const rows = await conn.sql<
        {
          kind: string;
          source_story: string;
          reporter: string;
          wording: string;
        }[]
      >`
        select l.kind, l.source_story, o.reporter, o.wording
        from ledger.learning l join ledger.learning_occurrence o on o.learning_id = l.id
        order by l.id`;
      expect(rows).toEqual([
        {
          kind: "tech",
          source_story: "S-1",
          reporter: "retro",
          wording: "reran the full suite",
        },
        {
          kind: "tech",
          source_story: "S-1",
          reporter: "retro",
          wording: "quoted the CLI from memory",
        },
      ]);
      const retro = await events(conn, "retro");
      expect(retro).toHaveLength(1);
      if (outcome.ok)
        expect(retro[0]?.payload).toMatchObject({
          learning_ids: outcome.result.learning_ids,
          occurrence_ids: outcome.result.occurrence_ids,
          dispatch_id: "ctx_retro",
        });
    });

    test("an ambiguous finding is listed and not written, and a rerun with repeat_of completes", async () => {
      for (const text of ["first", "second"])
        await conn.db.insertLearning({
          source_story: "S-0",
          evidence_refs: ["transcript:ctx_dev:12"],
          text,
          adoption: "new",
          area: "process",
          project_id: null,
          kind: "tech",
          expected: normalizeExpected(finding().expected),
          theme: null,
          action_story: null,
          created_at: now(),
          adoption_at: now(),
        });
      const [first] = await conn.sql<{ id: number }[]>`
        select id from ledger.learning order by id limit 1`;
      const plain = finding({
        evidence_refs: ["pr:7"],
        area: "impl",
        expected: "a separate expectation",
      });
      const outcome = await record([plain, finding()]);
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          complete: false,
          ambiguous: [{ index: 1, text: finding().text }],
        },
      });
      expect(await events(conn, "retro")).toEqual([]);
      const before = await conn.sql`select id from ledger.learning_occurrence`;
      const done = await record([
        plain,
        finding({ repeat_of: first?.id ?? 0 }),
      ]);
      expect(done).toMatchObject({ ok: true, result: { complete: true } });
      const after = await conn.sql`select id from ledger.learning_occurrence`;
      expect(after.length).toBe(before.length + 1);
      expect(await events(conn, "retro")).toHaveLength(1);
    });

    test("a rerun after the retro event converges on the same result", async () => {
      const first = await record([finding()]);
      const second = await record([finding()]);
      expect(second).toMatchObject({ ok: true, result: { replayed: true } });
      if (first.ok && second.ok)
        expect(second.result.learning_ids).toEqual(first.result.learning_ids);
      expect(await events(conn, "retro")).toHaveLength(1);
      const other = await record([
        finding({ text: "a different finding", expected: "something else" }),
      ]);
      expect(other).toMatchObject({ ok: true, result: { replayed: true } });
      expect(await conn.sql`select id from ledger.learning`).toHaveLength(1);
      const rerun = await runRetro([]);
      expect(rerun).toMatchObject({
        ok: true,
        result: { state: "recorded", replayed: true },
      });
      if (first.ok && rerun.ok)
        expect(rerun.result.recorded?.learning_ids).toEqual(
          first.result.learning_ids,
        );
    });

    test("a transcript ref naming another Run's Dispatch is schema_invalid and writes nothing", async () => {
      const outcome = await record([
        finding({ evidence_refs: ["transcript:ctx_other:3"] }),
      ]);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "schema_invalid" },
      });
      expect(await conn.sql`select id from ledger.learning`).toHaveLength(0);
    });

    test("a policy without the tech kind refuses learning_kind_unknown before any write", async () => {
      await seed(["lead"]);
      await close(true);
      expect(await record([finding()])).toMatchObject({
        ok: false,
        refusal: { code: "learning_kind_unknown" },
      });
      expect(await conn.sql`select id from ledger.learning`).toHaveLength(0);
    });

    test("a process Revision with no retro step is schema_invalid", async () => {
      await clearDb(conn);
      await activeRevision(conn.db, "policy", "default", { gates: ["pr"] });
      await activeRevision(conn.db, "crew", "default", retroCrew);
      await activeRevision(conn.db, "process", "impl", processValue);
      await createRun(conn);
      await close(true);
      expect(await runRetro([])).toMatchObject({
        ok: false,
        refusal: { code: "schema_invalid" },
      });
    });
  });
});
