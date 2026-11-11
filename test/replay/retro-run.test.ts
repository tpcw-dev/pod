import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { retroRecord } from "../../src/core/retro/record.ts";
import { retroRun } from "../../src/core/retro/run.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import { createRun, dispatched, events } from "../db/run-fixture.ts";
import { activeRevision, crewValue, processValue } from "../db/seed.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/retro-run";

const hold = ["timeout", "cancel", "unknown"];

describeDb("retro-run", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await activeRevision(conn.db, "policy", "default", {
      gates: ["pr"],
      learning: { kinds: ["lead", "tech"] },
    });
    await activeRevision(conn.db, "crew", "default", {
      seats: [
        ...crewValue.seats,
        { id: "retro-1", roles: ["retro"], runtime: "harness-a" },
      ],
    });
    await activeRevision(conn.db, "process", "impl", {
      ...processValue,
      roles: [...processValue.roles, "retro"],
      steps: [
        ...processValue.steps,
        {
          id: "retro",
          type: "worker",
          role: "retro",
          after: "close",
          method: "Check each quote against the transcript.",
        },
      ],
      edges: [
        ...processValue.edges,
        { from: "retro", on: "done", to: "done" },
        { from: "retro", on: hold, to: "hold" },
      ],
    });
    const host = await storeRevision(conn.db, {
      ...envelope("host", "local", {
        driver: "hat-a",
        hostnames: ["local"],
        manager: true,
        slots: { default: 2, max: 3 },
        reserved: {},
        projects: ["*"],
        transcripts: { "harness-a": "/transcripts/{session_id}.jsonl" },
      }),
      scope: "host",
      scope_ref: "local",
    });
    await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "host",
      name: "local",
      expected: null,
      revision_id: host.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date(),
    });
    await createRun(conn);
  });
  afterAll(() => conn.close());

  test("a closed Run due a retro dispatches the retro Seat, records its locator, and converges on the recorded retro", async () => {
    await dispatched(conn, "ctx_1");
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    await conn.db.appendEvent({
      type: "pr",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: "task_b",
      dispatch_id: "ctx_1",
      op_key: null,
      payload: { number: 7, url: "https://code.example/pr/7", head: "abc1234" },
      source: { kind: "command", verb: "check" },
    });
    await conn.db.setRunState("run_1", "done");
    await conn.db.appendEvent({
      type: "close",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: closeStepKey("run_1", "archive"),
      payload: {
        op_key: closeStepKey("run_1", "archive"),
        retro_due: true,
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

    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({ dir, sink: log.sink });
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
    const outcome = await retroRun(conn.db, orca, log, {
      run: "run_1",
      seat: "retro-1",
      generation: 1,
      attempt: "1",
      host: "local",
      capacity: 3,
      codeHost,
      command: "pod retro run:run_1 --seat retro-1 --generation 1",
      now: () => new Date(),
    });
    orca.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "dispatched",
        task_id: "task_retro",
        dispatch_id: "ctx_retro",
        transcripts: [{ dispatch_id: "ctx_1", status: "absent" }],
      },
    });
    expect(codeHost.calls).toEqual(["pr 7"]);
    const retro = (await conn.db.listDispatches("run_1")).find(
      (row) => row.dispatch_id === "ctx_retro",
    );
    expect(retro?.effective_launch).toMatchObject({
      transcript: { harness: "harness-a", session_id: "sess-retro" },
    });
    expect((await conn.db.getRun("run_1"))?.state).toBe("done");

    const recorded = await retroRecord(conn.db, {
      run: "run_1",
      findings: [
        {
          text: "the review request named no head SHA",
          area: "process",
          evidence_refs: ["transcript:ctx_1:4", "pr:7"],
          wording: "asked for review without the SHA",
        },
      ],
      host: "local",
      now: () => new Date(),
    });
    expect(recorded).toMatchObject({
      ok: true,
      result: { complete: true, replayed: false },
    });
    const [event] = await events(conn, "retro");
    expect(event).toMatchObject({
      dispatch_id: "ctx_retro",
      task_id: "task_retro",
    });

    const again = await retroRun(conn.db, orca, log, {
      run: "run_1",
      seat: "retro-1",
      generation: 1,
      attempt: "1",
      host: "local",
      capacity: 3,
      codeHost,
      command: "pod retro run:run_1 --seat retro-1 --generation 1",
      now: () => new Date(),
    });
    expect(again).toMatchObject({
      ok: true,
      result: { state: "recorded", replayed: true },
    });
    if (recorded.ok && again.ok)
      expect(again.result.recorded?.learning_ids).toEqual(
        recorded.result.learning_ids,
      );
  });
});
