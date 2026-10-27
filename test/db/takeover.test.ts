import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  recordTakeover,
  takeover,
  type TakeoverInput,
  type TakeoverRequest,
} from "../../src/core/run/takeover.ts";
import {
  fixtures,
  lost,
  noCalls,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { describeDb, openDb, podHome, resetDb, runCli } from "./helpers.ts";
import {
  dispatched,
  empty,
  events,
  freshRun,
  replay,
  workers,
} from "./run-fixture.ts";

const run1 = ["--run", "run_1"];

const oldHandle = "term_138f909e-aaa2-496c-97ea-796ec49e4fb8";
const newHandle = "term_new";
const requestId = "77777777-7777-4777-8777-777777777777";
const views = mkdtempSync(join(tmpdir(), "pod-restore-"));

function orcaRun(handle: string, generation: number) {
  return {
    run: {
      id: "run_1",
      objective: "Pod Run for story:S-1",
      coordinator_handle: handle,
      consumer_generation: generation,
      legacy: 0,
    },
  };
}

function recordedStdout(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { stdout: string }).stdout;
}

const recorded = {
  runShow: recordedStdout("test/db/takeover-unsafe/001-run-show.json"),
  open: recordedStdout("test/db/takeover-unsafe/002-terminal-show.json"),
  closed: recordedStdout(
    "fixtures/orca/two-coordinator-handoff/006-terminal-show.json",
  ),
};

const runShow = (handle = oldHandle): TempEntry =>
  handle === oldHandle
    ? { verb: "run-show", argv: ["--id", "run_1"], stdout: recorded.runShow }
    : ok("run-show", orcaRun(handle, 1), ["--id", "run_1"]);

function terminal(handle: string, open: boolean): TempEntry {
  if (handle === oldHandle)
    return {
      verb: "terminal-show",
      argv: ["--terminal", handle],
      stdout: open ? recorded.open : recorded.closed,
    };
  return ok(
    "terminal-show",
    {
      terminal: {
        handle,
        connected: open,
        writable: open,
        exitCause: open ? null : { kind: "operator_close" },
      },
    },
    ["--terminal", handle],
  );
}

const staleHandle = (handle: string): TempEntry => ({
  verb: "terminal-show",
  argv: ["--terminal", handle],
  exitCode: 1,
  stdout: readFileSync(
    "test/db/takeover-unsafe/terminal-show-missing.stdout",
    "utf8",
  ),
});

const runUse = (from = newHandle) =>
  ok(
    "run-use",
    {
      ...orcaRun(from, 2),
      mutation: { requestId, replayed: false },
    },
    ["--id", "run_1", "--from", from],
  );

const stopped = () => [runShow(), terminal(oldHandle, false)];

function input(over: Partial<TakeoverInput> = {}): TakeoverInput {
  return {
    story: "S-1",
    provider: "linear",
    generation: 1,
    coordinator: newHandle,
    opKey: null,
    viewPath: (runId, generation) => join(views, `${runId}-${generation}.html`),
    host: "local",
    command: (opKey) => `pod takeover story:S-1 --op-key ${opKey}`,
    now: () => new Date(),
    ...over,
  };
}

describeDb("pod takeover", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await conn.sql`update ledger.run set coordinator = ${oldHandle}`;
    await dispatched(conn, "ctx_1");
  });
  afterAll(() => conn.close());

  async function run(
    entries: readonly TempEntry[],
    over: Partial<TakeoverInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await takeover(conn.db, orca, log, input(over));
    orca.assertDone();
    return outcome;
  }

  async function pass(entries: readonly TempEntry[], generation = 1) {
    const { orca, log } = replay(conn, entries);
    const outcome = await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation,
      host: "local",
      capacity: 2,
      now: () => new Date(),
    });
    orca.assertDone();
    return outcome;
  }

  const operations = () =>
    conn.sql<{ op_key: string; status: string }[]>`
      select op_key, status from ledger.operation where intent = 'takeover' order by created_at`;
  const owner = async () => {
    const row = await conn.db.getRun("run_1");
    return { generation: row?.owner_generation, coordinator: row?.coordinator };
  };

  test("a live old coordinator is takeover_unsafe with no run-use, recorded refused", async () => {
    const outcome = await run([runShow(), terminal(oldHandle, true)]);
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        code: "takeover_unsafe",
        message: `the old coordinator ${oldHandle} has not stopped`,
        nextSteps: [
          `orca terminal close --terminal ${oldHandle}`,
          "evidence accepted: terminal show reports connected false with an exitCause, or terminal_handle_stale, for every coordinator handle",
        ],
      },
    });
    expect((await operations()).map((row) => row.status)).toEqual(["refused"]);
    expect(await owner()).toEqual({ generation: 1, coordinator: oldHandle });
  });

  test("an unreadable run-show is takeover_unsafe without a terminal read", async () => {
    const outcome = await run([lost("run-show", ["--id", "run_1"])]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "takeover_unsafe",
        nextSteps: [
          `orca terminal close --terminal ${oldHandle}`,
          expect.any(String),
        ],
      },
    });
  });

  test("a rerun after the stop gets the next attempt key and takes the Run", async () => {
    const first = await run([runShow(), terminal(oldHandle, true)]);
    expect(first.ok).toBe(false);
    const outcome = await run([...stopped(), runUse()]);
    expect(outcome).toMatchObject({
      ok: true,
      opKey: expect.stringMatching(/^takeover:/),
      result: {
        run_id: "run_1",
        owner_generation: 2,
        coordinator: newHandle,
        previous_coordinator: oldHandle,
        consumer_generation: 2,
        nextSteps: ["pod check --run run_1 --generation 2"],
      },
    });
    const rows = await operations();
    expect(rows.map((row) => row.status)).toEqual(["refused", "done"]);
    expect(rows[0]?.op_key).not.toBe(rows[1]?.op_key);
    expect(await owner()).toEqual({ generation: 2, coordinator: newHandle });
  });

  test("the takeover event names both handles and generations, the view, and the manifest", async () => {
    const outcome = await run([...stopped(), runUse()]);
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { result, opKey } = outcome;
    const [event] = await events(conn, "takeover");
    expect(event?.payload).toEqual({
      op_key: opKey,
      previous_coordinator: oldHandle,
      coordinator: newHandle,
      previous_generation: 1,
      owner_generation: 2,
      consumer_generation: 2,
      view_path: join(views, "run_1-2.html"),
      manifest_id: result.manifest_id,
    });
    const manifest = await conn.db.getManifest(result.manifest_id);
    expect(manifest).toMatchObject({ run_id: "run_1", task_id: null });
    expect(
      (manifest?.references as { source: string }[]).map((row) => row.source),
    ).toEqual(["story", "run", "task", "task", "crew", "process", "policy"]);
    expect(result.restore_view).toContain("owner generation 2");
    expect(result.restore_view).toContain(`coordinator ${newHandle}`);
    expect(result.restore_view).toContain("ctx_1 seat dev-1 task task_b");
    expect(result.restore_view).toContain("task_b build developer dispatched");
    expect(result.restore_view).toContain("task_r review reviewer pending");
    expect(result.restore_view).toContain(
      "- pod check --run run_1 --generation 2",
    );
  });

  test("every coordinator handle must be stopped: the ledger's and Orca's", async () => {
    const outcome = await run([
      runShow("term_orca"),
      terminal(oldHandle, false),
      terminal("term_orca", true),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "takeover_unsafe",
        nextSteps: [
          "orca terminal close --terminal term_orca",
          expect.any(String),
        ],
      },
    });
    expect(
      await run([
        runShow("term_orca"),
        terminal(oldHandle, false),
        staleHandle("term_orca"),
        runUse(),
      ]),
    ).toMatchObject({ ok: true, result: { owner_generation: 2 } });
  });

  test("the caller's own terminal is not evidence against it", async () => {
    expect(
      await run([runShow(newHandle), terminal(oldHandle, false), runUse()]),
    ).toMatchObject({ ok: true, result: { owner_generation: 2 } });
  });

  test("a stale caller is owner_generation_stale, recorded refused", async () => {
    expect(await run(stopped(), { generation: 2 })).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect((await operations()).map((row) => row.status)).toEqual(["refused"]);
    expect(await owner()).toEqual({ generation: 1, coordinator: oldHandle });
  });

  test("no Run for the Story is story_not_found", async () => {
    expect(
      await takeover(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        input({ story: "S-none" }),
      ),
    ).toEqual({
      ok: false,
      refusal: {
        code: "story_not_found",
        message: "no Run for story:S-none",
        nextSteps: ["pod brief"],
      },
    });
  });

  test("a lost compare-and-set race is refused owner_generation_stale and names the owner", async () => {
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({
      dir: fixtures([...stopped(), runUse()]),
      sink: async (record) => {
        await log.sink(record);
        if (record.verb === "run-use")
          await conn.sql`update ledger.run set owner_generation = 2, coordinator = 'term_other'`;
      },
    });
    const outcome = await takeover(conn.db, orca, log, input());
    orca.assertDone();
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        code: "owner_generation_stale",
        message:
          "takeover at generation 1 lost the race; the Run's owner generation is 2 and its coordinator is term_other",
        nextSteps: [
          "pod takeover story:S-1 --generation 2 from this terminal if this session should still own the Run",
        ],
      },
    });
    expect((await operations()).map((row) => row.status)).toEqual(["refused"]);
    expect(await events(conn, "takeover")).toEqual([]);
  });

  test("a lost run-use reply is unknown and launch_unknown", async () => {
    const outcome = await run([
      ...stopped(),
      lost("run-use", ["--id", "run_1", "--from", newHandle]),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: {
        code: "launch_unknown",
        nextSteps: [
          expect.stringMatching(/^pod takeover story:S-1 --op-key takeover:/),
          "pod check --run run_1 --generation 1",
        ],
      },
    });
    expect((await operations()).map((row) => row.status)).toEqual(["unknown"]);
    expect(await owner()).toEqual({ generation: 1, coordinator: oldHandle });
  });

  test("an exit-0 run-use with no readable Run keeps the mutation request id", async () => {
    await run([
      ...stopped(),
      ok("run-use", { mutation: { requestId, replayed: false } }, [
        "--id",
        "run_1",
        "--from",
        newHandle,
      ]),
    ]);
    const [row] = await operations();
    expect(row?.status).toBe("unknown");
    expect(
      (
        (await conn.db.getOperation(row?.op_key ?? ""))?.result_ref as {
          requestId: string | null;
        }
      ).requestId,
    ).toBe(requestId);
  });

  test("an op key reused with another generation is duplicate_op", async () => {
    const taken = await run([...stopped(), runUse()], { opKey: "k-gen" });
    expect(taken).toMatchObject({ ok: true });
    expect(
      await takeover(
        conn.db,
        noCalls(),
        receiptLog(conn.db, "local"),
        input({ opKey: "k-gen", generation: 2 }),
      ),
    ).toMatchObject({ ok: false, refusal: { code: "duplicate_op" } });
  });

  async function unknownTakeover(): Promise<string> {
    await run([...stopped(), unknownReply("run-use", requestId)]);
    const [row] = await operations();
    expect(row?.status).toBe("unknown");
    return row?.op_key ?? "";
  }

  const shown = (state: string) =>
    ok("request-show", { requestId, state }, ["--request", requestId]);

  test("pod check replays a completed run-use, records the takeover, and ends the pass", async () => {
    const opKey = await unknownTakeover();
    const outcome = await pass([
      shown("completed"),
      ok("run-use", orcaRun(newHandle, 2), [
        "--id",
        "run_1",
        "--from",
        newHandle,
        "--retry-request",
        requestId,
      ]),
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        nextSteps: [
          "pod check --run run_1 --generation 2",
          `pod takeover story:S-1 --generation 1 --op-key ${opKey}`,
        ],
      },
    });
    expect(await owner()).toEqual({ generation: 2, coordinator: newHandle });
    expect((await events(conn, "takeover"))[0]?.payload).toMatchObject({
      op_key: opKey,
      owner_generation: 2,
    });
    const rerun = await takeover(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      input({ opKey }),
    );
    expect(rerun).toMatchObject({
      ok: true,
      opKey,
      result: { owner_generation: 2, view_path: join(views, "run_1-2.html") },
    });
  });

  test("pod check leaves a pending request unknown and calls no Orca check", async () => {
    const opKey = await unknownTakeover();
    expect(await pass([shown("pending")])).toMatchObject({
      ok: true,
      result: {
        deliveries: [],
        nextSteps: [
          `pod check: takeover ${opKey} is still unknown`,
          "pod check --run run_1 --generation 1",
        ],
      },
    });
    expect((await operations()).map((row) => row.status)).toEqual(["unknown"]);
  });

  test("pod check moves an absent request to done failed, and the rerun takes the next attempt", async () => {
    const opKey = await unknownTakeover();
    expect(await pass([shown("absent")])).toMatchObject({
      ok: true,
      result: {
        nextSteps: [
          "pod takeover story:S-1 --generation 1",
          "pod check --run run_1 --generation 1",
        ],
      },
    });
    expect((await conn.db.getOperation(opKey))?.status).toBe("done");
    const outcome = await run([...stopped(), runUse()]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { owner_generation: 2 },
    });
    expect(outcome.ok && outcome.opKey).not.toBe(opKey);
  });

  const reconciledAs = async (opKey: string) =>
    (
      (await conn.db.getOperation(opKey))?.result_ref as {
        reconciled?: string;
      } | null
    )?.reconciled;

  const lostNoId = () =>
    run([
      ...stopped(),
      lost("run-use", ["--id", "run_1", "--from", newHandle]),
    ]);

  test("pod check closes a takeover left open under an older generation and runs the pass", async () => {
    await lostNoId();
    const [open] = await operations();
    expect(
      await run([...stopped(), runUse()], { opKey: "k-later" }),
    ).toMatchObject({ ok: true, result: { owner_generation: 2 } });
    const checked = await pass(
      [ok("check", empty(), run1), ok("worker-list", workers([]), run1)],
      2,
    );
    expect(checked).toMatchObject({ ok: true, result: { run_id: "run_1" } });
    expect((await conn.db.getOperation(open?.op_key ?? ""))?.status).toBe(
      "done",
    );
    expect(await reconciledAs(open?.op_key ?? "")).toBe("superseded");
  });

  test("pod check closes a takeover with no request id when run-show names another handle", async () => {
    await lostNoId();
    const [open] = await operations();
    expect(await pass([runShow()])).toMatchObject({
      ok: true,
      result: {
        nextSteps: [
          "pod takeover story:S-1 --generation 1",
          "pod check --run run_1 --generation 1",
        ],
      },
    });
    expect(await reconciledAs(open?.op_key ?? "")).toBe("not_bound");
    const retaken = await run([...stopped(), runUse()]);
    expect(retaken).toMatchObject({
      ok: true,
      result: { owner_generation: 2 },
    });
    expect(retaken.ok && retaken.opKey).not.toBe(open?.op_key);
  });

  test("a run-use that answers after pod check closed its takeover records nothing", async () => {
    await lostNoId();
    const [open] = await operations();
    await pass([runShow()]);
    const recorded = await recordTakeover(conn.db, {
      opKey: open?.op_key ?? "",
      request: (
        (await conn.db.getOperation(open?.op_key ?? ""))?.result_ref as {
          request: TakeoverRequest;
        }
      ).request,
      consumerGeneration: 2,
      host: "local",
      verb: "takeover",
      at: new Date(),
    });
    expect(recorded).toMatchObject({
      kind: "refused",
      refusal: { code: "failed" },
    });
    expect(await owner()).toEqual({ generation: 1, coordinator: oldHandle });
    expect(await events(conn, "takeover")).toEqual([]);
  });

  test("pod check settles a reply lost with no request id through run-show", async () => {
    await run([
      ...stopped(),
      lost("run-use", ["--id", "run_1", "--from", newHandle]),
    ]);
    expect(
      await pass([ok("run-show", orcaRun(newHandle, 2), ["--id", "run_1"])]),
    ).toMatchObject({
      ok: true,
      result: {
        nextSteps: ["pod check --run run_1 --generation 2", expect.any(String)],
      },
    });
    expect(await owner()).toEqual({ generation: 2, coordinator: newHandle });
  });

  test("the CLI needs POD_COORDINATOR and writes the view at --out and at the default path", () => {
    const missing = runCli(["takeover", "story:S-1", "--generation", "1"], {
      POD_COORDINATOR: "",
    });
    expect(missing.status).toBe(2);
    expect(missing.json.error?.code).toBe("usage");
    const unsafe = runCli(["takeover", "story:S-1", "--generation", "1"], {
      POD_COORDINATOR: newHandle,
      POD_ORCA_FIXTURES: fixtures([runShow(), terminal(oldHandle, true)]),
    });
    expect(unsafe.status).toBe(3);
    expect(unsafe.json.error?.code).toBe("takeover_unsafe");
    const out = join(views, "cli.html");
    const taken = runCli(
      ["takeover", "story:S-1", "--generation", "1", "--out", out],
      {
        POD_COORDINATOR: newHandle,
        POD_ORCA_FIXTURES: fixtures([...stopped(), runUse()]),
      },
    );
    expect(taken.status).toBe(0);
    expect(taken.json).toMatchObject({
      ok: true,
      result: { owner_generation: 2, view_path: out },
      meta: { ownerGeneration: 2 },
    });
    expect(readFileSync(out, "utf8")).toContain("owner generation 2");
    const rerun = runCli(
      [
        "takeover",
        "story:S-1",
        "--generation",
        "1",
        "--op-key",
        String(taken.json.result?.["op_key"]),
      ],
      {
        POD_COORDINATOR: newHandle,
        POD_ORCA_FIXTURES: fixtures([ok("no-call-expected", {})]),
      },
    );
    expect(rerun.json).toMatchObject({ ok: true, result: { view_path: out } });
  });

  test("the default view path is under POD_HOME/restore", () => {
    const taken = runCli(["takeover", "story:S-1", "--generation", "1"], {
      POD_COORDINATOR: newHandle,
      POD_ORCA_FIXTURES: fixtures([...stopped(), runUse()]),
    });
    const path = join(podHome, "restore", "run_1-2.html");
    expect(taken.json).toMatchObject({ ok: true, result: { view_path: path } });
    expect(existsSync(path)).toBe(true);
  });
});
