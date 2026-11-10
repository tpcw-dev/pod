import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import {
  closeRun,
  closeStepKey,
  type CloseInput,
} from "../../src/core/run/close.ts";
import { buildState } from "../../src/core/state/view.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { clearDb, describeDb, openDb, resetDb } from "./helpers.ts";
import { createRun, events } from "./run-fixture.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

let conn: Connection;
let tracker: FakeTracker;

const offline: OrcaPort = {
  ...noCalls(),
  version: () => Promise.reject(new Error("no Orca call expected")),
};

const actor = "person:operator-1";

const storyStatus = { done: "Done", human_wait: "In-review" };

const humanGated: Json = {
  ...processValue,
  steps: [
    { id: "build", type: "worker", role: "developer", spec: "Build it." },
    {
      id: "review",
      type: "worker",
      role: "reviewer",
      needs: ["build"],
      gate: "hqa_after_deploy",
    },
  ],
};

async function seed(policy: Json, process: Json = processValue) {
  await clearDb(conn);
  await activeRevision(conn.db, "policy", "default", policy);
  await activeRevision(conn.db, "crew", "default", crewValue);
  await activeRevision(conn.db, "process", "impl", process);
  await createRun(conn);
  await conn.db.setTaskState("task_b", "done");
  await conn.db.setTaskState("task_r", "done");
}

function reportOf(value: unknown): Pick<CloseInput, "report" | "reportHash"> {
  const report = CloseReport.parse(value);
  return { report, reportHash: sha256Hex(canonicalJson(report)) };
}

function input(over: Partial<CloseInput> = {}): CloseInput {
  return {
    story: "S-1",
    provider: "linear",
    generation: 1,
    ...reportOf({}),
    keepFilesReviewed: false,
    host: "local",
    worktreeStatus: () => ({ files: [], ahead: 0 }),
    now: () => new Date(),
    tracker,
    actor,
    ...over,
  };
}

function close(over: Partial<CloseInput> = {}) {
  return closeRun(conn.db, offline, receiptLog(conn.db, "local"), input(over));
}

async function closeOps() {
  return conn.sql<{ op_key: string; status: string }[]>`
    select op_key, status from ledger.operation where intent = 'close' order by op_key`;
}

async function learningRows() {
  return conn.sql<
    {
      text: string;
      area: string;
      source_story: string;
      evidence_refs: string[];
      adoption: string;
    }[]
  >`select text, area, source_story, evidence_refs, adoption from ledger.learning order by id`;
}

async function outboxRows() {
  return conn.sql<{ op_key: string; payload: Json; acked_at: Date | null }[]>`
    select op_key, payload, acked_at from ledger.outbox order by id`;
}

async function fail(gate: string, outcome: "PASS" | "FAIL") {
  const task = (await conn.db.listTasks("run_1")).find(
    (row) => row.task_id === "task_r",
  );
  await conn.db.insertGateReceipt({
    gate_id: gate,
    run_id: "run_1",
    task_id: "task_r",
    scope: "task",
    spec_revision_id: task?.spec_revision_id ?? "",
    candidate_sha: "abc1234",
    deployed_revision: null,
    keeper: "human-gatekeeper",
    outcome,
    source: { kind: "test" },
    sync_state: "synced",
    created_at: new Date(),
  });
}

const records = {
  learnings: [
    { text: "seed the fixture first", area: "impl", evidence_refs: ["pr:7"] },
  ],
  leftovers: [
    { text: "the brief truncates long titles", area: "product" },
    { text: "main went red after the merge", area: "impl", p0: "main_red" },
  ],
};

describeDb("pod run close records", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    tracker = fakeTracker();
    await seed({ gates: ["pr"], story_status: storyStatus });
  });
  afterAll(async () => {
    await conn.close();
  });

  test("learnings and leftovers are written once across a stopped and repeated close", async () => {
    tracker.failRead = true;
    const stopped = await close(reportOf(records));
    expect(stopped).toMatchObject({
      ok: false,
      refusal: { code: "tracker_unconfirmed" },
    });
    expect(await learningRows()).toHaveLength(2);
    tracker.failRead = false;
    const outcome = await close(reportOf(records));
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
    const rows = await learningRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      text: "seed the fixture first",
      area: "impl",
      source_story: "S-1",
      evidence_refs: ["pr:7"],
      adoption: "new",
    });
    expect(rows[1]).toMatchObject({
      text: "the brief truncates long titles",
      area: "product",
      source_story: "S-1",
    });
    expect(rows[1]?.evidence_refs).toHaveLength(1);
    const manifest = await conn.db.getManifest(rows[1]?.evidence_refs[0] ?? "");
    expect(manifest?.run_id).toBe("run_1");
    const learned = await conn.sql<{ run_id: string | null }[]>`
      select run_id from ledger.event where type = 'learning' order by id`;
    expect(learned).toEqual([{ run_id: "run_1" }, { run_id: "run_1" }]);
  });

  test("a p0 leftover writes one escalate event, no learning, and the close completes", async () => {
    const outcome = await close(reportOf(records));
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "done",
        escalations: [
          { kind: "main_red", text: "main went red after the merge" },
        ],
      },
    });
    const escalated = await events(conn, "escalate");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.payload).toMatchObject({
      story: "S-1",
      kind: "main_red",
      text: "main went red after the merge",
      actor,
    });
    expect((await learningRows()).map((row) => row.text)).not.toContain(
      "main went red after the merge",
    );
    const state = await buildState(
      { repo: conn.db, docs: null, now: () => new Date() },
      { story: "S-1", project: null },
    );
    if (!state.ok) throw new Error(state.refusal.message);
    expect(state.view.needs_human.items).toContainEqual(
      expect.objectContaining({
        story: "S-1",
        run_id: "run_1",
        gate: "p0 main_red",
        keeper: "operator",
        open: true,
        reason: "main went red after the merge",
      }),
    );
  });

  test("retro_due is true for an m Story and prints retro: required", async () => {
    await conn.sql`update ledger.story set size = 'm' where external_id = 'S-1'`;
    const outcome = await close();
    expect(outcome).toMatchObject({ ok: true, result: { retro_due: true } });
    if (outcome.ok)
      expect(outcome.result.nextSteps).toContain("retro: required");
    expect((await events(conn, "close"))[0]?.payload).toMatchObject({
      retro_due: true,
      actor,
    });
  });

  test("retro_due is true for an s Story with a FAIL receipt", async () => {
    await fail("pr", "FAIL");
    const outcome = await close();
    expect(outcome).toMatchObject({ ok: true, result: { retro_due: true } });
  });

  test("retro_due is false for an s Story with no FAIL, and no retro line prints", async () => {
    await fail("pr", "PASS");
    const outcome = await close();
    expect(outcome).toMatchObject({ ok: true, result: { retro_due: false } });
    if (outcome.ok)
      expect(outcome.result.nextSteps).not.toContain("retro: required");
  });

  test("the closing comment is posted once, and done waits for its readback", async () => {
    tracker.failReadbacks = [2];
    const stopped = await close(reportOf(records));
    expect(stopped).toMatchObject({
      ok: false,
      refusal: { code: "tracker_unconfirmed" },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("active");
    expect(await closeOps()).toContainEqual({
      op_key: closeStepKey("run_1", "comment"),
      status: "pending",
    });
    const outcome = await close(reportOf(records));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusal));
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
    const posts = tracker.calls.filter((call) => call === "postComment");
    expect(posts).toHaveLength(1);
    expect(tracker.comments).toHaveLength(1);
    const ids = (
      await conn.sql<{ id: number }[]>`
      select id from ledger.learning order by id`
    ).map((row) => row.id);
    expect(tracker.comments[0]?.body).toBe(
      [
        `${actor}: closed Run run_1`,
        "",
        "Worktree: not removed",
        "Branches removed: not removed",
        "Remote branches kept: not removed",
        `Learnings: ${ids.join(", ")}`,
        "p0: main_red: main went red after the merge",
        "Retro due: no",
      ].join("\n"),
    );
    expect(
      (await outboxRows()).filter(
        (row) => row.op_key === closeStepKey("run_1", "comment"),
      ),
    ).toHaveLength(1);
    expect(await close(reportOf(records))).toMatchObject({
      ok: true,
      result: { already_closed: true },
    });
    expect(tracker.comments).toHaveLength(1);
  });

  test("the Story moves to human_wait while hqa_after_deploy is pending", async () => {
    await seed(
      {
        gates: {
          pr: { keeper: "reviewer-seat", type: "AQA" },
          hqa_after_deploy: { keeper: "human-gatekeeper", type: "HQA" },
        },
        story_status: storyStatus,
      },
      humanGated,
    );
    const outcome = await close();
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
    expect(tracker.story.status).toBe("In-review");
  });

  test("the Story moves to done once hqa_after_deploy has a PASS", async () => {
    await seed(
      {
        gates: {
          pr: { keeper: "reviewer-seat", type: "AQA" },
          hqa_after_deploy: { keeper: "human-gatekeeper", type: "HQA" },
        },
        story_status: storyStatus,
      },
      humanGated,
    );
    await fail("hqa_after_deploy", "PASS");
    expect(await close()).toMatchObject({ ok: true });
    expect(tracker.story.status).toBe("Done");
  });

  test("a pinned policy with no story_status writes no status", async () => {
    await seed({ gates: ["pr"] });
    expect(await close()).toMatchObject({ ok: true });
    expect(tracker.calls).not.toContain("setStatus");
    expect(
      (await outboxRows()).map((row) => (row.payload as { kind: string }).kind),
    ).toEqual(["comment"]);
  });

  test("a Story a person canceled refuses story_canceled, keeps the hold, and posts no comment", async () => {
    tracker.story = {
      ...tracker.story,
      status: "Canceled",
      statusType: "canceled",
    };
    for (let i = 0; i < 2; i += 1) {
      const outcome = await close();
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "story_canceled" },
      });
      expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    }
    expect(tracker.calls).not.toContain("postComment");
    expect(
      (await outboxRows()).map((row) => (row.payload as { kind: string }).kind),
    ).toEqual(["status"]);
  });

  test("a status the tracker lacks finishes the close and names the status to set by hand", async () => {
    const lacking: TrackerPort = {
      ...tracker,
      setStatus: () =>
        Promise.resolve({
          verb: "setStatus",
          ok: false,
          result: { story: tracker.story },
          raw: null,
          error: "status_unknown",
          requestId: null,
        }),
    };
    const outcome = await close({ tracker: lacking });
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
    if (outcome.ok)
      expect(outcome.result.nextSteps).toContain(
        "story:S-1: the tracker has no status Done; set it by hand",
      );
  });

  test("no tracker refuses tracker_unconfirmed and writes no step", async () => {
    const outcome = await close({ tracker: null });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "tracker_unconfirmed" },
    });
    expect(await closeOps()).toEqual([]);
  });
});
