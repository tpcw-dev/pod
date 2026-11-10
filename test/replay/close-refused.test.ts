import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { worktreeStatus } from "../../src/cli/git.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { closeRun, type CloseInput } from "../../src/core/run/close.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { dispatched, events, freshRun } from "../db/run-fixture.ts";
import { fakeGit } from "../db/close-ports.ts";
import { fakeTracker } from "../db/fake-tracker.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/close-refused";

const tip = "b".repeat(40);

const prompt = "term_fffa698b-af31-4063-9b90-aac6f58561d5";
const agent = "term_82938c87-90ca-4080-88d4-1e81d112fd22";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function worktreeWithUntrackedFile(): string {
  const path = mkdtempSync(join(tmpdir(), "pod-close-worktree-"));
  git(path, "init", "-q");
  git(
    path,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  writeFileSync(join(path, "notes.txt"), "draft\n");
  return path;
}

describeDb("close-refused", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  test("a Run walks through owed work, an unanswered question, an unreadable screen, a needs-file refusal, and an open PR before it closes", async () => {
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({ dir, sink: log.sink });
    const report = CloseReport.parse({});
    const input = (over: Partial<CloseInput> = {}): CloseInput => ({
      story: "S-1",
      provider: "linear",
      generation: 1,
      report,
      reportHash: sha256Hex(canonicalJson(report)),
      keepFilesReviewed: false,
      host: "local",
      worktreeStatus,
      now: () => new Date(),
      tracker: fakeTracker(),
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      actor: "person:operator-1",
      ...over,
    });
    const terminal = (handle: string) =>
      conn.sql`update ledger.dispatch set terminal_handle = ${handle} where dispatch_id = 'ctx_1'`;

    await dispatched(conn, "ctx_1");
    expect(await closeRun(conn.db, orca, log, input())).toMatchObject({
      ok: false,
      refusal: { code: "owed_work" },
    });

    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    await conn.db.settleDispatch("ctx_1", {
      activity: "settled",
      settlement: "done",
      settled_at: new Date(),
    });
    await terminal(prompt);
    expect(await closeRun(conn.db, orca, log, input())).toMatchObject({
      ok: false,
      refusal: {
        code: "unanswered_question",
        message: expect.stringContaining("yes, take option A"),
      },
    });

    const edited =
      "004-terminal-read.json has only source edited to screen-unavailable";
    expect(await closeRun(conn.db, orca, log, input()), edited).toMatchObject({
      ok: false,
      refusal: {
        code: "unanswered_question",
        message: expect.stringContaining("could not be read"),
      },
    });

    const worktree = worktreeWithUntrackedFile();
    await terminal(agent);
    await conn.sql`update ledger.dispatch set requested_launch = jsonb_set(requested_launch, '{worktree}', to_jsonb(${`id:repo-1::${worktree}`}::text)) where dispatch_id = 'ctx_1'`;
    const stale = await closeRun(conn.db, orca, log, input());
    expect(
      stale,
      "a stale draft over an empty composer row passes",
    ).toMatchObject({
      ok: false,
      refusal: { code: "needs_file" },
    });
    if (!stale.ok)
      expect(stale.refusal.nextSteps).toContain(`${worktree}: notes.txt`);
    expect(await events(conn, "close")).toEqual([]);

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
    const git = fakeGit({
      checkout: () => Promise.resolve({ repo: "/r", branch: "feature-7", tip }),
    });
    const pr = (state: "open" | "merged") =>
      makeFixtureCodeHost({
        prs: [
          {
            number: 7,
            state,
            head_branch: "feature-7",
            head_sha: tip,
            merge_commit: null,
          },
        ],
      });
    const open = await closeRun(
      conn.db,
      orca,
      log,
      input({ keepFilesReviewed: true, git, codeHost: pr("open") }),
    );
    expect(open).toMatchObject({ ok: false, refusal: { code: "open_pr" } });
    if (!open.ok)
      expect(open.refusal.nextSteps).toContain(
        "merge or close PR #7, then run the close again",
      );
    expect(await events(conn, "close")).toEqual([]);

    const closed = await closeRun(
      conn.db,
      orca,
      log,
      input({ keepFilesReviewed: true, git, codeHost: pr("merged") }),
    );
    expect(closed).toMatchObject({
      ok: true,
      result: {
        state: "done",
        keep_files_reviewed: {
          actor: "operator",
          host: "local",
          worktrees: [{ path: worktree, files: ["notes.txt"], ahead: 0 }],
        },
      },
    });
    expect(await events(conn, "close")).toHaveLength(1);
    orca.assertDone();
  });
});
