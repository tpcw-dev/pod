import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import {
  CloseReport,
  CloseStepName,
  type WorktreeStatus,
} from "../../src/core/domain/close.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { closeRun, type CloseInput } from "../../src/core/run/close.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { lost, noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { cliReplay, generation } from "./decision-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import { residentSeat } from "./resident-fixture.ts";
import { dispatched, events, freshRun, replay } from "./run-fixture.ts";
import { closeBody, closeCommentTracker } from "./close-tracker.ts";
import { fakeGit, removedWorktree } from "./close-ports.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { operator } from "./identity-fixture.ts";

let conn: Connection;

const emptyReport = CloseReport.parse({});
const emptyHash = sha256Hex(canonicalJson(emptyReport));
const clean: WorktreeStatus = { files: [], ahead: 0 };

function input(over: Partial<CloseInput> = {}): CloseInput {
  return {
    story: "S-1",
    provider: "linear",
    generation: 1,
    report: emptyReport,
    reportHash: emptyHash,
    keepFilesReviewed: false,
    host: "local",
    worktreeStatus: () => clean,
    now: () => new Date(),
    tracker: fakeTracker(),
    codeHost: makeFixtureCodeHost(),
    git: fakeGit(),
    actor: "person:operator-1",
    ...over,
  };
}

const shown = (handle: string, open: boolean): TempEntry =>
  ok(
    "terminal-show",
    {
      terminal: open
        ? { handle, connected: true, writable: true }
        : {
            handle,
            connected: false,
            writable: false,
            exitCause: { kind: "operator_close" },
          },
    },
    ["--terminal", handle],
  );

const read = (
  handle: string,
  tail: string[],
  extra: Record<string, unknown> = { source: "screen" },
): TempEntry =>
  ok(
    "terminal-read",
    { terminal: { handle, status: "running", tail, ...extra } },
    ["--terminal", handle, "--screen"],
  );

const grokBox = (text: string) => [
  "     Worked for 51s",
  `  ╭${"─".repeat(40)}╮`,
  `  │ ❯ ${text.padEnd(37)}│`,
  `  ╰${"─".repeat(20)} Grok 4.7 (medium) ─╯`,
  "  worktree │ Grok 4.7 │ 27% ctx",
];

const term = "term_ctx_1";

function noOpenPrs(): string {
  const file = join(mkdtempSync(join(tmpdir(), "pod-code-host-")), "host.json");
  writeFileSync(file, "{}");
  return file;
}

const forced = (entry: TempEntry): TempEntry => ({
  ...entry,
  argv: [...(entry.argv ?? []), "--force"],
});

const rmError = (code: string): TempEntry => ({
  verb: "worktree-rm",
  argv: ["--worktree", "id:repo-1::/w/one"],
  exitCode: 1,
  stdout: JSON.stringify({ ok: false, error: { code, message: code } }),
});

const checkout = { repo: "/r", branch: "feature-7", tip: "a".repeat(40) };

const closedPr = {
  number: 7,
  state: "closed" as const,
  head_branch: "feature-7",
  head_sha: "a".repeat(40),
  merge_commit: null,
};

const closeTracker = () =>
  closeCommentTracker("S-1", closeBody(`person:${operator}`, "run_1"));

async function operations() {
  return conn.sql<{ op_key: string; status: string }[]>`
    select op_key, status from ledger.operation where intent = 'close' order by created_at, op_key`;
}

async function runState() {
  return (await conn.db.getRun("run_1"))?.state;
}

async function finishTasks() {
  await conn.db.setTaskState("task_b", "done");
  await conn.db.setTaskState("task_r", "done");
}

async function settle(dispatchId: string) {
  await conn.db.settleDispatch(dispatchId, {
    activity: "settled",
    settlement: "done",
    settled_at: new Date(),
    at: new Date(),
  });
}

async function readyToClose() {
  await dispatched(conn, "ctx_1");
  await finishTasks();
  await settle("ctx_1");
}

async function close(entries: TempEntry[], over: Partial<CloseInput> = {}) {
  const { orca, log } = replay(conn, entries);
  const outcome = await closeRun(conn.db, orca, log, input(over));
  orca.assertDone();
  return outcome;
}

const offline: OrcaPort = {
  ...noCalls(),
  version: () => Promise.reject(new Error("no Orca call expected")),
};

async function seatDispatch(id: string, worktree: string) {
  await conn.db.insertOperation({
    op_key: `seat-${id}`,
    intent: "dispatch",
    owner_generation: 1,
    at: new Date(),
  });
  await conn.db.moveOperation(`seat-${id}`, "done", null, new Date());
  await conn.db.insertDispatch({
    dispatch_id: id,
    task_id: "task_r",
    decision_id: null,
    run_id: "run_1",
    seat: "dev-2",
    role: "developer",
    requested_launch: { worktree },
    effective_launch: null,
    model_attribution: "unknown",
    retry_of: null,
    op_key: `seat-${id}`,
    settlement: "done",
    terminal_handle: null,
    created_at: new Date(),
    settled_at: new Date(),
    activity: "settled",
    manifest_id: null,
    prompt_bytes: null,
  });
  await conn.db.appendEvent({
    type: "start",
    ts: new Date(),
    host: "local",
    run_id: "run_1",
    task_id: "task_r",
    dispatch_id: id,
    op_key: `seat-${id}`,
    payload: {},
    source: { kind: "command", verb: "dispatch" },
  });
}

async function openDecision(state: string) {
  const at = new Date();
  await conn.db.insertManifest({
    id: "man_1",
    run_id: "run_1",
    task_id: null,
    decision_id: null,
    parent_id: null,
    references: [],
    tests: null,
    created_at: at,
  });
  await conn.db.insertDecision({
    id: "dec_1",
    run_id: "run_1",
    task_id: null,
    category: "plan",
    effect: "accept_plan",
    question: "q",
    options: [],
    manifest_id: "man_1",
    state,
    outcome: null,
    reason: null,
    binding: "run",
    budget: {},
    spent: {},
    supersedes_decision_id: null,
    adoption: "pending",
    adoption_evidence: [],
    created_at: at,
    closed_at: null,
  });
}

describeDb("pod run close", () => {
  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(async () => {
    await conn.close();
  });

  test("a Task that is not done refuses owed_work with no Orca call and writes no step", async () => {
    const outcome = await closeRun(
      conn.db,
      offline,
      replay(conn, []).log,
      input(),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owed_work" },
    });
    if (outcome.ok) return;
    expect(outcome.refusal.nextSteps).toContain("Task task_b is ready");
    expect(outcome.refusal.nextSteps).toContain("Task task_r is pending");
    expect(await operations()).toEqual([]);
    expect(await events(conn, "close")).toEqual([]);
    expect(await runState()).toBe("active");
  });

  test("a running Dispatch refuses owed_work", async () => {
    await dispatched(conn, "ctx_1");
    await finishTasks();
    const outcome = await closeRun(
      conn.db,
      offline,
      replay(conn, []).log,
      input(),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owed_work" },
    });
    if (!outcome.ok)
      expect(outcome.refusal.nextSteps).toContain("Dispatch ctx_1 is running");
    expect(await operations()).toEqual([]);
  });

  test.each(["round:1", "needs_human", "reserved_needs_human"])(
    "a Decision in %s refuses owed_work",
    async (state) => {
      await readyToClose();
      await openDecision(state);
      const outcome = await closeRun(
        conn.db,
        offline,
        replay(conn, []).log,
        input(),
      );
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "owed_work" },
      });
      if (!outcome.ok)
        expect(outcome.refusal.nextSteps).toContain(
          `Decision dec_1 is ${state}`,
        );
      expect(await operations()).toEqual([]);
    },
  );

  test("text in the composer row of an open Dispatch terminal refuses unanswered_question", async () => {
    await readyToClose();
    const outcome = await close([
      shown(term, true),
      read(term, grokBox("yes, take option A")),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "unanswered_question" },
    });
    if (!outcome.ok)
      expect(outcome.refusal.nextSteps[0]).toBe(
        `orca terminal read --terminal ${term} --screen`,
      );
    expect(await operations()).toEqual([]);
  });

  test("a claude prompt row with text refuses unanswered_question", async () => {
    await readyToClose();
    const outcome = await close([
      shown(term, true),
      read(term, [
        "● done",
        "❯ please confirm the merge",
        "─".repeat(30),
        "Opus",
      ]),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "unanswered_question" },
    });
  });

  test("a stale draft over an empty composer row does not refuse", async () => {
    await readyToClose();
    const outcome = await close([
      shown(term, true),
      read(term, grokBox(""), { source: "screen", draft: "old input" }),
      removedWorktree(),
    ]);
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
  });

  test.each([
    ["screen-unavailable", { source: "screen-unavailable" }],
    ["stream", { source: "stream" }],
    ["absent", {}],
  ])(
    "a terminal read whose source is %s refuses unanswered_question",
    async (_name, extra) => {
      await readyToClose();
      const outcome = await close([
        shown(term, true),
        read(term, grokBox(""), extra),
      ]);
      expect(outcome).toMatchObject({
        ok: false,
        refusal: { code: "unanswered_question" },
      });
      if (!outcome.ok)
        expect(outcome.refusal.message).toContain("could not be read");
    },
  );

  test("a failed terminal read refuses unanswered_question", async () => {
    await readyToClose();
    const outcome = await close([shown(term, true), lost("terminal-read")]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "unanswered_question" },
    });
  });

  test("a closed Dispatch terminal is not read", async () => {
    await readyToClose();
    const outcome = await close([shown(term, false), removedWorktree()]);
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
  });

  test("an untracked file refuses needs_file and lists it", async () => {
    await readyToClose();
    const outcome = await close([shown(term, false)], {
      worktreeStatus: () => ({ files: ["notes.txt"], ahead: 0 }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "needs_file" },
    });
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("/w/one");
    expect(outcome.refusal.nextSteps).toContain("/w/one: notes.txt");
    expect(outcome.refusal.nextSteps.at(-1)).toBe(
      "pod run close story:S-1 --generation 1 --keep-files-reviewed after a person reviewed the files",
    );
    expect(await operations()).toEqual([]);
  });

  test("a branch ahead of its upstream refuses needs_file", async () => {
    await readyToClose();
    const outcome = await close([shown(term, false)], {
      worktreeStatus: () => ({ files: [], ahead: 1 }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "needs_file" },
    });
    if (!outcome.ok)
      expect(outcome.refusal.nextSteps).toContain(
        "/w/one: branch ahead of its upstream by 1",
      );
  });

  test("--keep-files-reviewed passes needs_file and records the actor per worktree", async () => {
    await readyToClose();
    await seatDispatch("ctx_2", "id:repo-1::/w/two");
    const statuses: Record<string, WorktreeStatus> = {
      "/w/one": { files: [], ahead: 1 },
      "/w/two": { files: ["foo"], ahead: 4 },
    };
    const outcome = await close(
      [
        shown(term, false),
        forced(removedWorktree()),
        forced(removedWorktree("id:repo-1::/w/two")),
      ],
      {
        keepFilesReviewed: true,
        worktreeStatus: (path) => statuses[path] ?? null,
      },
    );
    const recorded = {
      actor: "operator",
      host: "local",
      worktrees: [
        { path: "/w/one", files: [], ahead: 1 },
        { path: "/w/two", files: ["foo"], ahead: 4 },
      ],
    };
    expect(outcome).toMatchObject({
      ok: true,
      result: { keep_files_reviewed: recorded },
    });
    const [event] = await events(conn, "close");
    expect(event?.payload["keep_files_reviewed"]).toEqual(recorded);
  });

  test("--keep-files-reviewed with nothing to review records nothing", async () => {
    await readyToClose();
    const outcome = await close([shown(term, false), removedWorktree()], {
      keepFilesReviewed: true,
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { keep_files_reviewed: null },
    });
  });

  test("a missing worktree is listed as gone, and a current worktree is omitted", async () => {
    await readyToClose();
    await seatDispatch("ctx_2", "current");
    const seen: string[] = [];
    const outcome = await close([shown(term, false), removedWorktree()], {
      worktreeStatus: (path) => {
        seen.push(path);
        return null;
      },
    });
    expect(seen).toEqual(["/w/one"]);
    expect(outcome).toMatchObject({ ok: true, result: { gone: ["/w/one"] } });
  });

  test("a clean close runs the keyed steps, writes one close event, and sets the Run done", async () => {
    await readyToClose();
    const outcome = await close([shown(term, false), removedWorktree()]);
    const archive = closeStepKey("run_1", "archive");
    const done = closeStepKey("run_1", "done");
    expect(outcome).toMatchObject({
      ok: true,
      opKey: done,
      result: {
        run_id: "run_1",
        story: "S-1",
        state: "done",
        owner_generation: 1,
        report_hash: emptyHash,
        report: { learnings: 0, leftovers: 0, decisions: 0 },
        steps: CloseStepName.options.map((step) => ({
          step,
          op_key: closeStepKey("run_1", step),
          status: "done",
          replayed: false,
        })),
        pr_events: [],
        keep_files_reviewed: null,
        gone: [],
        worktrees: [{ path: "/w/one", removed: true, via: "removed" }],
        branches: [],
        already_closed: false,
      },
    });
    expect(await operations()).toEqual(
      expect.arrayContaining([
        { op_key: archive, status: "done" },
        { op_key: done, status: "done" },
      ]),
    );
    const run = await conn.db.getRun("run_1");
    const closes = await events(conn, "close");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.payload).toMatchObject({
      op_key: archive,
      snapshot_hash: run?.snapshot_hash,
      report_hash: emptyHash,
      dispatches: [
        {
          dispatch_id: "ctx_1",
          seat: "dev-1",
          model_attribution: expect.any(String),
          settlement: "done",
        },
      ],
      seats: [
        {
          seat: "dev-1",
          dispatch_id: "ctx_1",
          activity: "settled",
          settlement: "done",
        },
      ],
      pr_events: [],
    });
    expect(run?.state).toBe("done");
  });

  test("a worktree Orca no longer knows counts as removed", async () => {
    await readyToClose();
    const outcome = await close([
      shown(term, false),
      rmError("selector_not_found"),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { worktrees: [{ path: "/w/one", removed: true, via: "absent" }] },
    });
  });

  test("a worktree rm that fails for another reason refuses failed and leaves the step pending", async () => {
    await readyToClose();
    const outcome = await close([
      shown(term, false),
      rmError("worktree_archive_hook_failed"),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "failed",
        message: expect.stringContaining("worktree_archive_hook_failed"),
      },
    });
    expect(await operations()).toEqual(
      expect.arrayContaining([
        { op_key: closeStepKey("run_1", "worktree"), status: "pending" },
      ]),
    );
    expect(await runState()).toBe("active");
  });

  test("the close lists the Run's pr events and closes when the code host reads none open", async () => {
    await readyToClose();
    await conn.db.appendEvent({
      type: "pr",
      ts: new Date(),
      host: "local",
      run_id: "run_1",
      task_id: "task_b",
      dispatch_id: "ctx_1",
      op_key: null,
      payload: { number: 7, state: "open" },
      source: { kind: "command", verb: "check" },
    });
    const outcome = await close([shown(term, false), removedWorktree()], {
      git: fakeGit({ checkout: () => Promise.resolve(checkout) }),
      codeHost: makeFixtureCodeHost({ prs: [closedPr] }),
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { pr_events: [{ payload: { number: 7, state: "open" } }] },
    });
  });

  test("an archive step left unknown with its event written reads back without a second event", async () => {
    await readyToClose();
    const key = closeStepKey("run_1", "archive");
    const at = new Date();
    await conn.db.insertOperation({
      op_key: key,
      intent: "close",
      owner_generation: 1,
      at,
    });
    await conn.db.appendEvent({
      type: "close",
      ts: at,
      host: "local",
      run_id: "run_1",
      task_id: null,
      dispatch_id: null,
      op_key: key,
      payload: { op_key: key, report_hash: emptyHash, marker: "first" },
      source: { kind: "command", verb: "run close" },
    });
    await conn.db.moveOperation(key, "unknown", null, at);
    const outcome = await close([shown(term, false)]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        worktrees: [],
        state: "done",
        steps: CloseStepName.options.map((step) => ({
          step,
          replayed: step === "archive",
        })),
      },
    });
    const closes = await events(conn, "close");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.payload["marker"]).toBe("first");
    expect(await runState()).toBe("done");
  });

  test("an archive step left unknown with no event acts once", async () => {
    await readyToClose();
    const key = closeStepKey("run_1", "archive");
    const at = new Date();
    await conn.db.insertOperation({
      op_key: key,
      intent: "close",
      owner_generation: 1,
      at,
    });
    await conn.db.moveOperation(key, "unknown", null, at);
    const outcome = await close([shown(term, false), removedWorktree()]);
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await events(conn, "close")).toHaveLength(1);
    expect(await operations()).toEqual(
      expect.arrayContaining([{ op_key: key, status: "done" }]),
    );
  });

  test("a re-run of a closed Run returns the recorded result and writes nothing", async () => {
    await readyToClose();
    const first = await close([shown(term, false), removedWorktree()]);
    const before = await conn.sql`select count(*)::int as n from ledger.event`;
    const again = await closeRun(
      conn.db,
      offline,
      replay(conn, []).log,
      input({ generation: 7 }),
    );
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.result).toEqual({
      ...first.result,
      steps: first.result.steps.map((step) => ({ ...step, replayed: true })),
      already_closed: true,
    });
    expect(await conn.sql`select count(*)::int as n from ledger.event`).toEqual(
      before,
    );
  });

  test("a stale --generation refuses owner_generation_stale and writes no step", async () => {
    await readyToClose();
    const outcome = await closeRun(
      conn.db,
      offline,
      replay(conn, []).log,
      input({ generation: 2 }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(await operations()).toEqual([]);
  });

  test("a half-finished close with another report refuses duplicate_op", async () => {
    await readyToClose();
    const key = closeStepKey("run_1", "archive");
    const at = new Date();
    await conn.db.insertOperation({
      op_key: key,
      intent: "close",
      owner_generation: 1,
      at,
    });
    await conn.db.moveOperation(
      key,
      "done",
      { request: { run_id: "run_1", step: "archive", report_hash: "other" } },
      at,
    );
    const outcome = await close([shown(term, false)]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_op" },
    });
    expect(await runState()).toBe("active");
  });

  test("the Run's coordinator Dispatch is exempt from the running and composer checks", async () => {
    await readyToClose();
    await residentSeat(conn, "ctx_dec", "decider", "running");
    await conn.sql`update ledger.run set coordinator_dispatch_id = 'ctx_dec' where run_id = 'run_1'`;
    const outcome = await close([shown(term, false), removedWorktree()]);
    expect(outcome).toMatchObject({ ok: true, result: { state: "done" } });
  });

  test("the CLI refuses an invalid report FILE with schema_invalid before any read", () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-close-"));
    const file = join(dir, "close.yaml");
    writeFileSync(file, "learnings:\n  - text: x\n    area: nowhere\n");
    return cliReplay(conn, [
      "run",
      "close",
      "story:S-1",
      ...generation,
      file,
    ]).then((result) => {
      expect(result.status).toBe(2);
      expect(result.json.error?.code).toBe("schema_invalid");
    });
  });

  test("the CLI closes with an omitted FILE as the empty report", async () => {
    await finishTasks();
    const result = await cliReplay(
      conn,
      ["run", "close", "story:S-1", ...generation],
      [],
      { POD_TRACKER_FIXTURES: closeTracker() },
    );
    expect(result).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: {
          state: "done",
          report_hash: emptyHash,
          report: { learnings: 0, leftovers: 0, decisions: 0 },
        },
      },
    });
  });

  test("the CLI takes --keep-files-reviewed past needs_file and records the operator", async () => {
    await readyToClose();
    const worktree = mkdtempSync(join(tmpdir(), "pod-close-cli-"));
    expect(spawnSync("git", ["-C", worktree, "init", "-q"]).status).toBe(0);
    writeFileSync(join(worktree, "notes.txt"), "draft\n");
    await conn.sql`update ledger.dispatch set terminal_handle = null, requested_launch = jsonb_set(requested_launch, '{worktree}', to_jsonb(${`id:repo-1::${worktree}`}::text)) where dispatch_id = 'ctx_1'`;
    const args = ["run", "close", "story:S-1", ...generation];
    const refused = await cliReplay(conn, args);
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("needs_file");
    const branch = spawnSync(
      "git",
      ["-C", worktree, "symbolic-ref", "--short", "HEAD"],
      { encoding: "utf8" },
    ).stdout.trim();
    const kept = await cliReplay(
      conn,
      [...args, "--keep-files-reviewed"],
      [forced(removedWorktree(`id:repo-1::${worktree}`))],
      {
        POD_TRACKER_FIXTURES: closeCommentTracker(
          "S-1",
          closeBody(`person:${operator}`, "run_1", {
            worktree: `removed ${worktree}`,
            kept: `${branch} (integration unreadable; local kept: integration unreadable)`,
          }),
        ),
        POD_CODE_HOST_FIXTURES: noOpenPrs(),
      },
    );
    expect(kept).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: {
          state: "done",
          keep_files_reviewed: {
            actor: "operator",
            host: "local",
            worktrees: [{ path: worktree, files: ["notes.txt"], ahead: 0 }],
          },
        },
      },
    });
  });
});
