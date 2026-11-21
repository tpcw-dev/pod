import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  proposeGroom,
  type ProposeInput,
} from "../../src/core/groom/propose.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { RepoReader } from "../../src/core/ports/repo-reader.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { trackerReceipts } from "./tracker-scenario.ts";

const dir = "fixtures/tracker/groom-proposal";
const sha = "abc1234def5678abc1234def5678abc1234def56";
const proved =
  "Proved: 1 caller, 0 fakes, 0 asserting tests, 1/1 check fails today, origin/main abc1234 2026-11-20";
const activate = [
  "--activate",
  "--scope",
  "global",
  "--expected-revision",
  "none",
];

const reader: RepoReader = {
  resolve: () => Promise.resolve(sha),
  grep: (_repo, _sha, _under, pattern) =>
    Promise.resolve(
      "word" in pattern && pattern.word === "parseThing"
        ? [{ path: "src/a.ts", line: 3, text: "  parseThing();" }]
        : [],
    ),
  show: () => Promise.resolve(""),
  exists: () => Promise.resolve(true),
  runCheck: (_repo, _sha, command) =>
    Promise.resolve({ command, state: "fails", exit: 1 }),
};

function input(over: Partial<ProposeInput> = {}): ProposeInput {
  return {
    story: { provider: "linear", external_id: "TRK-1" },
    stage: null,
    points: 3,
    reason: "one design choice",
    repo: "/repo",
    sha,
    ref: "origin/main",
    date: "2026-11-20",
    functions: ["parseThing"],
    asserts: [],
    checks: ["exit 1"],
    files: ["src/a.ts"],
    timeoutMs: 1000,
    host: "rec",
    actor: "person:operator",
    command: "pod groom story:TRK-1",
    now: () => new Date("2026-11-20T18:00:00.000Z"),
    ...over,
  };
}

const processes = mkdtempSync(join(tmpdir(), "pod-groom-process-"));

function processFile(name: string, selector: string): string {
  const path = join(processes, `${name}.yaml`);
  writeFileSync(
    path,
    readFileSync("test/replay/stale-dispatch-id/process.yaml", "utf8")
      .replace(/^name: .*$/m, `name: ${name}`)
      .replace(/^ {2}selector: .*$/m, `  selector: ${selector}`),
  );
  return path;
}

function apply(path: string): void {
  const applied = runCli(["config", "apply", path, ...activate]);
  expect(applied.status, applied.json.error?.message).toBe(0);
}

describeDb("groom-proposal", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const path of [
      "test/replay/stale-dispatch-id/policy.yaml",
      "test/replay/stale-dispatch-id/crew.yaml",
      "specs/groom/default.yaml",
      processFile("impl-small", "{ stage: impl, size: [xs, s] }"),
      processFile("impl-medium", "{ stage: impl, size: [m] }"),
    ])
      apply(path);
  });
  afterAll(() => conn.close());

  function propose(fixtures: string, over: Partial<ProposeInput> = {}) {
    const log = receiptLog(conn.db, "rec");
    const tracker = makeReplayTracker({
      dir: fixtures,
      sink: log.trackerSink,
      estimateScale: "fibonacci",
    });
    return {
      tracker,
      run: () => proposeGroom(conn.db, tracker, reader, log, input(over)),
    };
  }

  async function written() {
    return {
      events: await conn.sql<{ payload: Record<string, unknown> }[]>`
        select payload from ledger.event where type = 'groom_proved' order by id`,
      outbox: await conn.sql<{ kind: string; acked: boolean }[]>`
        select payload->>'kind' as kind, acked_at is not null as acked
        from ledger.outbox order by id`,
    };
  }

  test("a proposal sets the estimate, posts one pod: groom proposal comment, reads both back, and a rerun replays", async () => {
    const { tracker, run } = propose(dir);
    const first = await run();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result).toMatchObject({
      story: { provider: "linear", external_id: "TRK-1" },
      stage: "impl",
      points: 3,
      proposed: false,
      reason: "one design choice",
      size: "m",
      kickoff: "impl-medium@1",
      counters: { callers: 1, fakes: 0, asserting: 0, failing: 1, checks: 1 },
      checks: [{ command: "exit 1", state: "fails", exit: 1 }],
      paths: [{ path: "src/a.ts", present: true }],
      proved,
      recorded: true,
      delivered: { acked: 2, failed: 0 },
    });
    expect(first.result.body).toBe(
      [
        "pod: groom proposal",
        "Stage: impl",
        "Points: 3",
        "Size: m",
        "Kickoff: impl-medium@1",
        "Reason: one design choice",
        proved,
      ].join("\n"),
    );
    const again = await run();
    tracker.assertDone();
    expect(again).toMatchObject({
      ok: true,
      result: {
        op_key: first.result.op_key,
        recorded: false,
        delivered: { acked: 0, failed: 0 },
      },
    });
    expect(await trackerReceipts(conn)).toEqual([
      { verb: "readStory", operation: "Story" },
      { verb: "setEstimate", operation: "SetEstimate" },
      { verb: "readback", operation: "Story" },
      { verb: "readback", operation: "StoryComments" },
      { verb: "postComment", operation: "PostComment" },
      { verb: "readback", operation: "Story" },
      { verb: "readback", operation: "StoryComments" },
      { verb: "readStory", operation: "Story" },
    ]);
    const { events, outbox } = await written();
    expect(events).toEqual([
      {
        payload: {
          story: "TRK-1",
          provider: "linear",
          groom_revision: first.result.groom_revision,
          stage: "impl",
          points: 3,
          proposed: false,
          reason: "one design choice",
          size: "m",
          kickoff: "impl-medium@1",
          ref: "origin/main",
          sha,
          date: "2026-11-20",
          counters: {
            callers: 1,
            fakes: 0,
            asserting: 0,
            failing: 1,
            checks: 1,
          },
          proved,
        },
      },
    ]);
    expect(outbox).toEqual([
      { kind: "estimate", acked: true },
      { kind: "comment", acked: true },
    ]);
    const [source] = await conn.sql<{ source: unknown; run_id: null }[]>`
      select source, run_id from ledger.event where type = 'groom_proved'`;
    expect(source).toEqual({
      source: { kind: "command", verb: "groom", actor: "person:operator" },
      run_id: null,
    });
  });

  test("without --points the default_points rule proposes the points, marked proposed, with the rule's inputs as the reason", async () => {
    const { tracker, run } = propose(join(dir, "defaulted"), {
      points: null,
      reason: null,
    });
    const outcome = await run();
    tracker.assertDone();
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        points: 1,
        proposed: true,
        reason: "default_points: 1 paths, 1 callers",
        size: "xs",
        kickoff: "impl-small@1",
        recorded: true,
        delivered: { acked: 2, failed: 0 },
      },
    });
    if (!outcome.ok) return;
    expect(outcome.result.body.split("\n").slice(2, 6)).toEqual([
      "Points: 1 (proposed)",
      "Size: xs",
      "Kickoff: impl-small@1",
      "Reason: default_points: 1 paths, 1 callers",
    ]);
    const [event] = await conn.sql<{ proposed: boolean }[]>`
      select (payload->>'proposed')::boolean as proposed from ledger.event
      where type = 'groom_proved' order by id desc limit 1`;
    expect(event).toEqual({ proposed: true });
  });

  test("points off the scale, points at split_at, and an unresolved process write nothing", async () => {
    const before = await written();
    const { tracker } = propose(join(dir, "refused"));
    const refusal = async (over: Partial<ProposeInput>) => {
      const outcome = await proposeGroom(
        conn.db,
        tracker,
        reader,
        receiptLog(conn.db, "rec"),
        input(over),
      );
      return outcome.ok ? null : outcome.refusal.code;
    };
    expect(await refusal({ points: 4 })).toBe("points_invalid");
    expect(await refusal({ points: 8 })).toBe("split_required");
    expect(await refusal({ stage: "prd" })).toBe("selector_none");
    apply(processFile("prd", "{ stage: prd }"));
    apply(processFile("prd-other", "{ stage: prd }"));
    expect(await refusal({ stage: "prd" })).toBe("selector_many");
    tracker.assertDone();
    expect(await written()).toEqual(before);
  });
});
