import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { release, type ReleaseInput } from "../../src/core/dispatch/release.ts";
import { derivedOpKey } from "../../src/core/ledger/op-key.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { noCalls, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { fixtures } from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { dispatched, events, freshRun, replay } from "./run-fixture.ts";

const argv = ["--dispatch", "ctx_1"];
const answer = (state: string) =>
  ok("worker-release", { dispatchId: "ctx_1", state }, argv);

describeDb("pod release", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
    await dispatched(conn, "ctx_1");
  });
  afterAll(() => conn.close());

  function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
    return {
      dispatch: "ctx_1",
      generation: 1,
      retain: null,
      host: "local",
      now: () => new Date(),
      ...over,
    };
  }

  async function run(
    entries: readonly TempEntry[],
    over: Partial<ReleaseInput> = {},
  ) {
    const { orca, log } = replay(conn, entries);
    const outcome = await release(conn.db, orca, log, input(over));
    orca.assertDone();
    return outcome;
  }

  async function quiet(over: Partial<ReleaseInput> = {}) {
    return release(
      conn.db,
      noCalls(),
      receiptLog(conn.db, "local"),
      input(over),
    );
  }

  const settle = () =>
    conn.sql`update ledger.dispatch set settlement = 'done', activity = 'settled', settled_at = now()`;

  test("a running Dispatch, another host, an unknown Dispatch, and a stale generation are refused", async () => {
    expect(await quiet()).toMatchObject({
      ok: false,
      refusal: {
        code: "release_refused",
        nextSteps: ["pod check", "--retain --reason"],
      },
    });
    await settle();
    expect(await quiet({ host: "elsewhere" })).toMatchObject({
      ok: false,
      refusal: {
        code: "release_refused",
        message: "Dispatch ctx_1 started on host local, not elsewhere",
      },
    });
    expect(await quiet({ dispatch: "ctx_none" })).toMatchObject({
      ok: false,
      refusal: { code: "release_refused" },
    });
    expect(await quiet({ generation: 2 })).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(
      await conn.sql`select 1 from ledger.operation where intent = 'release'`,
    ).toHaveLength(0);
  });

  test("a settled Dispatch releases, and a rerun returns the recorded result with no Orca call", async () => {
    await settle();
    const outcome = await run([answer("released")]);
    expect(outcome).toMatchObject({
      ok: true,
      opKey: expect.stringMatching(/^release:/),
      result: { dispatch_id: "ctx_1", state: "released", reason: null },
    });
    expect(await quiet()).toEqual(outcome);
    expect((await events(conn, "release")).map((row) => row.payload)).toEqual([
      expect.objectContaining({ state: "released", reason: null }),
    ]);
  });

  test("--retain --reason on a running Dispatch keeps the release open until a final answer", async () => {
    const retained = await run([answer("retained")], {
      retain: "keep for HQA",
    });
    expect(retained).toMatchObject({
      ok: true,
      result: { state: "retained", reason: "keep for HQA" },
    });
    await settle();
    const pending = await run([answer("release_pending")]);
    expect(pending).toMatchObject({
      ok: true,
      result: { state: "release_pending" },
    });
    const released = await run([answer("released")]);
    expect(released).toMatchObject({ ok: true, result: { state: "released" } });
    if (!retained.ok || !pending.ok || !released.ok) return;
    expect(new Set([retained.opKey, pending.opKey, released.opKey]).size).toBe(
      3,
    );
    expect(
      (await events(conn, "release")).map((row) => row.payload["state"]),
    ).toEqual(["retained", "release_pending", "released"]);
    expect((await quiet()).ok).toBe(true);
  });

  test("release_unknown leaves the operation unknown and fails; a rerun reuses the key", async () => {
    await settle();
    const first = await run([
      {
        verb: "worker-release",
        argv,
        exitCode: 1,
        stdout: JSON.stringify({
          ok: true,
          result: { dispatchId: "ctx_1", state: "release_unknown" },
        }),
      },
    ]);
    expect(first).toMatchObject({ ok: false, refusal: { code: "failed" } });
    const [row] = await conn.sql<{ op_key: string; status: string }[]>`
      select op_key, status from ledger.operation where intent = 'release'`;
    expect(row?.status).toBe("unknown");
    const again = await run([answer("already_released")]);
    expect(again).toMatchObject({
      ok: true,
      opKey: row?.op_key,
      result: { state: "already_released" },
    });
  });

  test("a pending key left by a dead process is reused", async () => {
    await settle();
    const opKey = derivedOpKey("release", {
      run_id: "run_1",
      dispatch_id: "ctx_1",
      attempt: "1",
    });
    await conn.db.insertOperation({
      op_key: opKey,
      intent: "release",
      owner_generation: 1,
      at: new Date(),
    });
    expect(await run([answer("already_released")])).toMatchObject({
      ok: true,
      opKey,
    });
  });

  test("the CLI exits 3 on a refusal, 2 on a lone --retain, and 0 on a release", async () => {
    const args = ["release", "--dispatch", "ctx_1", "--generation", "1"];
    const open = runCli(args);
    expect(open.status).toBe(3);
    expect(open.json.error?.code).toBe("release_refused");
    expect(runCli([...args, "--retain"]).status).toBe(2);
    expect(runCli([...args, "--reason", "r"]).status).toBe(2);
    await settle();
    const done = runCli(args, {
      POD_ORCA_FIXTURES: fixtures([answer("released")]),
    });
    expect(done.status).toBe(0);
    expect(done.json).toMatchObject({
      ok: true,
      result: { state: "released" },
      meta: { ownerGeneration: 1, opKey: expect.stringMatching(/^release:/) },
    });
  });
});
