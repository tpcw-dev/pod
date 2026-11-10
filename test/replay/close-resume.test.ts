import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { closeRun, closeStepKey } from "../../src/core/run/close.ts";
import { fakeGit } from "../db/close-ports.ts";
import { fakeTracker } from "../db/fake-tracker.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { dispatched, freshRun, worktreeId } from "../db/run-fixture.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/close-resume";

const tip = "d".repeat(40);

describeDb("close-resume", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  test("a close that crashes after the worktree step converges on the re-run without removing anything twice", async () => {
    await dispatched(conn, "ctx_1");
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    await conn.db.settleDispatch("ctx_1", {
      activity: "settled",
      settlement: "done",
      settled_at: new Date(),
    });
    await conn.sql`update ledger.dispatch set terminal_handle = null where dispatch_id = 'ctx_1'`;
    await conn.db.appendEvent({
      type: "pr",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: "task_b",
      dispatch_id: "ctx_1",
      op_key: null,
      payload: { number: 7, url: "https://code.example/pr/7", head: tip },
      source: { kind: "command", verb: "check" },
    });

    const refs = new Set(["local", "remote"]);
    let fetches = 0;
    let checkouts = 0;
    const git = fakeGit({
      checkout: () => {
        checkouts += 1;
        return Promise.resolve(
          checkouts === 1 ? { repo: "/r", branch: "feature-7", tip } : null,
        );
      },
      fetch: () =>
        (fetches += 1) === 1
          ? Promise.reject(new Error("crash after the worktree step"))
          : Promise.resolve(true),
      localTip: () => Promise.resolve(refs.has("local") ? tip : null),
      remoteTip: () => Promise.resolve(refs.has("remote") ? tip : null),
      deleteLocal: () => {
        refs.delete("local");
        return Promise.resolve({ ok: true });
      },
      deleteRemote: () => {
        refs.delete("remote");
        return Promise.resolve({ ok: true });
      },
    });
    const codeHost = makeFixtureCodeHost({
      prs: [
        {
          number: 7,
          state: "merged",
          head_branch: "feature-7",
          head_sha: tip,
          merge_commit: null,
        },
      ],
    });
    const tracker = fakeTracker();
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({ dir, sink: log.sink });
    const report = CloseReport.parse({});
    const input = {
      story: "S-1",
      provider: "linear",
      generation: 1,
      report,
      reportHash: sha256Hex(canonicalJson(report)),
      keepFilesReviewed: false,
      host: "local",
      worktreeStatus: () => ({ files: [], ahead: 0 }),
      now: () => new Date(),
      tracker,
      codeHost,
      git,
      actor: "person:operator-1",
    };

    await expect(closeRun(conn.db, orca, log, input)).rejects.toThrow(
      "crash after the worktree step",
    );
    expect(
      (await conn.db.getOperation(closeStepKey("run_1", "worktree")))?.status,
    ).toBe("done");
    expect(
      (await conn.db.getOperation(closeStepKey("run_1", "branches")))?.status,
    ).toBe("pending");
    expect(tracker.comments).toEqual([]);
    expect((await conn.db.getRun("run_1"))?.state).toBe("active");

    const calls = codeHost.calls.length;
    const closed = await closeRun(conn.db, orca, log, input);
    expect(closed).toMatchObject({
      ok: true,
      result: {
        state: "done",
        worktrees: [
          { path: worktreeId.split("::")[1], removed: true, via: "removed" },
        ],
        branches: [
          { branch: "feature-7", local: "absent", remote: "removed", pr: 7 },
        ],
      },
    });
    expect(codeHost.calls.slice(calls)).toEqual(["pr 7", "open feature-7"]);
    orca.assertDone();
    expect(tracker.comments).toHaveLength(1);
    expect(tracker.comments[0]?.body).toContain("Branches removed: feature-7");
    expect((await conn.db.getRun("run_1"))?.state).toBe("done");

    const again = await closeRun(conn.db, orca, log, input);
    expect(again).toMatchObject({ ok: true, result: { already_closed: true } });
    expect(tracker.comments).toHaveLength(1);
    orca.assertDone();
  });
});
