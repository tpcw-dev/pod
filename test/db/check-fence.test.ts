import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  fixtures,
  ok,
  unknownReply,
  type TempEntry,
} from "../orca/temp-fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  dispatched,
  dispatchInput,
  empty,
  events,
  freshRun,
  replay,
  taskState,
  workers,
} from "./run-fixture.ts";

const requestId = "66666666-6666-4666-8666-666666666666";
const run = ["--run", "run_1"];

describeDb("pod check stops at a moved owner generation", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  async function passBumpingOn(verb: string, entries: readonly TempEntry[]) {
    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({
      dir: fixtures(entries),
      sink: async (record) => {
        await log.sink(record);
        if (record.verb === verb)
          await conn.sql`update ledger.run set owner_generation = 2`;
      },
    });
    const outcome = await checkPass(conn.db, orca, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: 1,
      now: () => new Date(),
    });
    orca.assertDone();
    return outcome;
  }

  test("a stopped worker read after the bump writes no stop event and moves no Task", async () => {
    await dispatched(conn, "ctx_1");
    const outcome = await passBumpingOn("worker-list", [
      ok("check", empty(), run),
      ok(
        "worker-list",
        workers([{ dispatchId: "ctx_1", workerState: "stopped" }]),
        run,
      ),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect(await events(conn, "stop")).toEqual([]);
    expect((await conn.db.getDispatch("ctx_1"))?.settlement).toBe("open");
    expect(await taskState(conn, "task_b")).toBe("dispatched");
  });

  test("a bump before a reconcile record leaves the operation unknown", async () => {
    const launch = replay(conn, [unknownReply("worker-start", requestId)]);
    expect(
      await dispatch(conn.db, launch.orca, launch.log, dispatchInput()),
    ).toMatchObject({ ok: false, refusal: { code: "launch_unknown" } });
    const [row] = await conn.sql<{ op_key: string }[]>`
      select op_key from ledger.operation where intent = 'dispatch'`;
    const outcome = await passBumpingOn("request-show", [
      ok("request-show", { requestId, state: "absent" }, [
        "--request",
        requestId,
      ]),
      ok("worker-list", workers([]), run),
    ]);
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "owner_generation_stale" },
    });
    expect((await conn.db.getOperation(row?.op_key ?? ""))?.status).toBe(
      "unknown",
    );
    expect(await events(conn, "resume")).toEqual([]);
  });
});
