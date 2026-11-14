import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  makeFixtureCodeHost,
  type CodeHostFixture,
} from "../../src/adapters/code-host/fixture.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { realGit } from "../../src/cli/git.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { CodeHostPort, PrState } from "../../src/core/ports/code-host.ts";
import type { GitPort } from "../../src/core/ports/git.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { closeRun, type CloseInput } from "../../src/core/run/close.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { dispatched, freshRun } from "./run-fixture.ts";

const report = CloseReport.parse({});

function g(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file}\n`);
  g(cwd, "add", file);
  g(cwd, "commit", "-q", "-m", file);
  return g(cwd, "rev-parse", "HEAD");
}

interface Repos {
  origin: string;
  repo: string;
  worktree: string;
  tip: string;
}

function repos(branch = "feature-7"): Repos {
  const root = mkdtempSync(join(tmpdir(), "pod-close-branch-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, repo);
  g(repo, "checkout", "-q", "-b", "main");
  commit(repo, "base.txt");
  g(repo, "push", "-q", "-u", "origin", "main");
  g(repo, "remote", "set-head", "origin", "main");
  const worktree = join(root, "wt");
  g(repo, "worktree", "add", "-q", "-b", branch, worktree);
  const tip = commit(worktree, "work.txt");
  g(worktree, "push", "-q", "-u", "origin", branch);
  return { origin, repo, worktree, tip };
}

const merged = (number: number, branch: string, sha: string): PrState => ({
  number,
  state: "merged",
  head_branch: branch,
  head_sha: sha,
  merge_commit: null,
});

function gitOrca(repo: string): OrcaPort {
  return {
    ...noCalls(),
    worktreeRemove: (req) => {
      g(
        repo,
        "worktree",
        "remove",
        "--force",
        req.worktree.split("::")[1] ?? "",
      );
      return Promise.resolve({
        verb: "worktree-rm",
        exitCode: 0,
        result: { removed: true },
        raw: {},
        orcaVersion: "1.4.253",
      });
    },
  };
}

function spyGit(calls: string[]): GitPort {
  const spied = {} as Record<string, unknown>;
  for (const [name, method] of Object.entries(realGit))
    spied[name] = (...args: unknown[]) => {
      calls.push(`${name} ${String(args[1] ?? "")}`.trim());
      return (method as (...a: unknown[]) => unknown)(...args);
    };
  return spied as unknown as GitPort;
}

const remoteRef = (origin: string, branch: string) =>
  spawnSync(
    "git",
    ["-C", origin, "rev-parse", "--verify", "-q", `refs/heads/${branch}`],
    {
      encoding: "utf8",
    },
  ).stdout.trim();

describeDb("pod run close branches", () => {
  let conn: Connection;
  let tracker: FakeTracker;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await freshRun(conn);
    tracker = fakeTracker();
  });

  async function runOn(worktree: string, prs: readonly number[] = [7]) {
    await dispatched(conn, "ctx_1");
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    await conn.db.settleDispatch("ctx_1", {
      activity: "settled",
      settlement: "done",
      settled_at: new Date(),
      at: new Date(),
    });
    await conn.sql`update ledger.dispatch set terminal_handle = null, requested_launch = jsonb_set(requested_launch, '{worktree}', to_jsonb(${`id:repo-1::${worktree}`}::text)) where dispatch_id = 'ctx_1'`;
    for (const number of prs)
      await conn.db.appendEvent({
        type: "pr",
        ts: new Date(),
        host: "local",
        run_id: "run_1",
        task_id: "task_b",
        dispatch_id: "ctx_1",
        op_key: null,
        payload: {
          number,
          url: `https://code.example/pr/${number}`,
          head: "c".repeat(40),
        },
        source: { kind: "command", verb: "check" },
      });
  }

  function close(
    repo: string,
    over: Partial<CloseInput> & { fixture?: CodeHostFixture } = {},
  ) {
    const { fixture, ...rest } = over;
    return closeRun(conn.db, gitOrca(repo), receiptLog(conn.db, "local"), {
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
      codeHost: makeFixtureCodeHost(fixture ?? {}),
      git: realGit,
      actor: "person:operator-1",
      ...rest,
    });
  }

  const commentField = (name: string) =>
    tracker.comments[0]?.body
      .split("\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);

  test("a branch a merged PR proves is deleted locally and on the remote", async () => {
    const { origin, repo, worktree, tip } = repos();
    await runOn(worktree);
    const outcome = await close(repo, {
      fixture: { prs: [merged(7, "feature-7", tip)] },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        state: "done",
        worktrees: [{ path: worktree, removed: true, via: "removed" }],
        branches: [
          { branch: "feature-7", local: "removed", remote: "removed", pr: 7 },
        ],
      },
    });
    expect(await realGit.localTip(repo, "feature-7")).toBeNull();
    expect(remoteRef(origin, "feature-7")).toBe("");
    expect(commentField("Worktree")).toBe(`removed ${worktree}`);
    expect(commentField("Branches removed")).toBe("feature-7");
    expect(commentField("Remote branches kept")).toBe("none");
  });

  test("an open PR that appears after the refusal check keeps the branch", async () => {
    const { origin, repo, worktree, tip } = repos();
    await runOn(worktree);
    const fixture = makeFixtureCodeHost({ prs: [merged(7, "feature-7", tip)] });
    let lists = 0;
    const codeHost: CodeHostPort = {
      pr: fixture.pr,
      openPrs: () => Promise.resolve((lists += 1) === 1 ? [] : [9]),
    };
    const outcome = await close(repo, { codeHost });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        branches: [
          {
            branch: "feature-7",
            local: "kept",
            remote: "kept",
            local_reason: "open PR #9",
            remote_reason: "open PR #9",
          },
        ],
        nextSteps: expect.arrayContaining([
          "branch_kept feature-7 (remote): open PR #9",
        ]),
      },
    });
    expect(await realGit.localTip(repo, "feature-7")).toBe(tip);
    expect(remoteRef(origin, "feature-7")).toBe(tip);
    expect(commentField("Branches removed")).toBe("none");
    expect(commentField("Remote branches kept")).toBe(
      "feature-7 (open PR #9; local kept: open PR #9)",
    );
  });

  test("an open PR at the refusal check refuses open_pr and writes no step", async () => {
    const { repo, worktree, tip } = repos();
    await runOn(worktree);
    const outcome = await close(repo, {
      fixture: {
        prs: [merged(7, "feature-7", tip)],
        open: { "feature-7": [9] },
      },
    });
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "open_pr" } });
    expect(
      await conn.sql`select op_key from ledger.operation where intent = 'close'`,
    ).toEqual([]);
  });

  test("a remote tip that moved after the merge keeps the remote and names the move", async () => {
    const { origin, repo, worktree, tip } = repos();
    await runOn(worktree);
    const other = mkdtempSync(join(tmpdir(), "pod-close-other-"));
    g(other, "clone", "-q", "-b", "feature-7", origin, "c");
    const moved = commit(join(other, "c"), "late.txt");
    g(join(other, "c"), "push", "-q", "origin", "feature-7");
    const outcome = await close(repo, {
      fixture: { prs: [merged(7, "feature-7", tip)] },
    });
    const short = moved.slice(0, 7);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        branches: [
          {
            branch: "feature-7",
            local: "removed",
            remote: "kept",
            remote_reason: `remote moved to ${short}`,
          },
        ],
      },
    });
    expect(remoteRef(origin, "feature-7")).toBe(moved);
    expect(commentField("Remote branches kept")).toBe(
      `feature-7 (remote moved to ${short}; local removed)`,
    );
  });

  test("main, master, staging, and the integration branch are never touched", async () => {
    const { origin, repo, worktree } = repos();
    for (const branch of ["master", "staging", "release"]) {
      g(repo, "branch", branch, "main");
      g(repo, "push", "-q", "origin", branch);
    }
    g(repo, "remote", "set-head", "origin", "release");
    await runOn(worktree, [11, 12, 13, 14]);
    const before = ["main", "master", "staging", "release"].map((branch) =>
      remoteRef(origin, branch),
    );
    const sha = (branch: string) => g(repo, "rev-parse", branch);
    const calls: string[] = [];
    const outcome = await close(repo, {
      git: spyGit(calls),
      fixture: {
        prs: [
          merged(11, "main", sha("main")),
          merged(12, "master", sha("master")),
          merged(13, "staging", sha("staging")),
          merged(14, "release", sha("release")),
        ],
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const kept = outcome.result.branches.filter(
      (row) => row.local_reason === "protected branch",
    );
    expect(kept.map((row) => row.branch).sort()).toEqual([
      "main",
      "master",
      "release",
      "staging",
    ]);
    expect(
      ["main", "master", "staging", "release"].map((branch) =>
        remoteRef(origin, branch),
      ),
    ).toEqual(before);
    for (const branch of ["main", "master", "staging", "release"])
      expect(calls.filter((call) => call.endsWith(` ${branch}`))).toEqual([]);
  });

  test("an unreadable integration branch keeps every candidate and deletes nothing", async () => {
    const { origin, repo, worktree, tip } = repos();
    g(repo, "remote", "set-head", "origin", "-d");
    await runOn(worktree);
    const outcome = await close(repo, {
      fixture: { prs: [merged(7, "feature-7", tip)] },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        branches: [
          {
            branch: "feature-7",
            local: "kept",
            remote: "kept",
            local_reason: "integration unreadable",
            remote_reason: "integration unreadable",
          },
        ],
      },
    });
    expect(await realGit.localTip(repo, "feature-7")).toBe(tip);
    expect(remoteRef(origin, "feature-7")).toBe(tip);
  });

  test("a proved branch checked out in another worktree keeps its local ref and loses its remote", async () => {
    const { origin, repo, worktree, tip } = repos();
    const elsewhere = join(
      mkdtempSync(join(tmpdir(), "pod-close-else-")),
      "wt",
    );
    g(repo, "worktree", "add", "-q", "-f", elsewhere, "feature-7");
    await runOn(worktree);
    const outcome = await close(repo, {
      fixture: { prs: [merged(7, "feature-7", tip)] },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        branches: [
          {
            branch: "feature-7",
            local: "kept",
            local_reason: `checked out in ${elsewhere}`,
            remote: "removed",
          },
        ],
      },
    });
    expect(await realGit.localTip(repo, "feature-7")).toBe(tip);
    expect(remoteRef(origin, "feature-7")).toBe("");
    expect(commentField("Branches removed")).toBe(
      `feature-7 (local kept: checked out in ${elsewhere})`,
    );
    expect(commentField("Remote branches kept")).toBe("none");
  });

  test("a re-run reuses a recorded branch outcome and makes no git call for it", async () => {
    const { repo, worktree, tip } = repos();
    g(repo, "branch", "feature-8", tip);
    g(repo, "push", "-q", "origin", "feature-8");
    await runOn(worktree, [7, 8]);
    const fixture = {
      prs: [merged(7, "feature-7", tip), merged(8, "feature-8", tip)],
    };
    const first = makeFixtureCodeHost(fixture);
    let lists = 0;
    const crashing: CodeHostPort = {
      pr: first.pr,
      openPrs: (r, branch) => {
        lists += 1;
        if (branch === "feature-8" && lists > 2)
          return Promise.reject(new Error("crash"));
        return first.openPrs(r, branch);
      },
    };
    await expect(close(repo, { codeHost: crashing })).rejects.toThrow("crash");
    const row = await conn.db.getOperation(closeStepKey("run_1", "branches"));
    expect(row?.status).toBe("pending");
    expect(row?.result_ref).toMatchObject({
      partial: [{ branch: "feature-7", local: "removed", remote: "removed" }],
    });
    const calls: string[] = [];
    const outcome = await close(repo, { git: spyGit(calls), fixture });
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        branches: [
          { branch: "feature-7", local: "removed", remote: "removed" },
          { branch: "feature-8", local: "removed", remote: "removed" },
        ],
      },
    });
    expect(calls.filter((call) => call.endsWith(" feature-7"))).toEqual([]);
  });

  test("a close on another host refuses wrong_host and writes no step", async () => {
    const { repo, worktree } = repos();
    await runOn(worktree, []);
    const outcome = await close(repo, { host: "other" });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "wrong_host",
        nextSteps: ["run pod run close story:S-1 --generation 1 on host local"],
      },
    });
    expect(
      await conn.sql`select op_key from ledger.operation where intent = 'close'`,
    ).toEqual([]);
  });
});
