import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { slotRefusal } from "../../src/core/dispatch/launch-gate.ts";
import { fixtures, ok } from "../orca/temp-fixtures.ts";
import {
  describeDb,
  openDb,
  operatorHome,
  resetDb,
  runCli,
} from "./helpers.ts";
import { operator } from "./identity-fixture.ts";
import { empty, freshRun, replay, started, workers } from "./run-fixture.ts";
import { seedHost } from "./seed.ts";

const missing = {
  code: "config_missing",
  message: "host local has no active host Revision",
  nextSteps: expect.arrayContaining([
    "pod config apply specs/host/local.yaml --ticket K",
    "then a person runs pod config activate host.local@REV --scope host:local --expected-revision none",
  ]),
};

function dispatchCli(env: Record<string, string> = {}) {
  return runCli(
    ["dispatch", "--task", "task_b", "--seat", "dev-1", "--generation", "1"],
    {
      POD_ORCA_FIXTURES: fixtures([ok("worker-start", started("ctx_9"))]),
      ...env,
    },
  );
}

describeDb("host capacity", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });

  beforeEach(async () => {
    await freshRun(conn);
  });
  afterAll(() => conn.close());

  test("dispatch reads slots.default of the active host Revision", async () => {
    await seedHost(conn.db, 0);
    const full = dispatchCli();
    expect(full.status).toBe(3);
    expect(full.json.error?.code).toBe("quota_exhausted");

    await freshRun(conn);
    await seedHost(conn.db, 1);
    const launched = dispatchCli();
    expect(launched.status).toBe(0);
    expect(launched.json.result).toMatchObject({ dispatch_id: "ctx_9" });
  });

  test("dispatch with no active host Revision refuses config_missing", () => {
    const refused = dispatchCli();
    expect(refused.status).toBe(3);
    expect(refused.json.error).toMatchObject(missing);
  });

  test("a host Revision for another host_id is not this host's", async () => {
    await seedHost(conn.db, 2, "elsewhere");
    const refused = dispatchCli();
    expect(refused.json.error).toMatchObject(missing);
  });

  test("a host.yaml that still carries capacity is refused naming where it went", () => {
    const refused = dispatchCli({
      POD_HOME: operatorHome(operator, "capacity: 2\n"),
    });
    expect(refused.status).toBe(2);
    expect(refused.json.error).toMatchObject({
      code: "schema_invalid",
      nextSteps: [
        "capacity: moved to slots.default of the active host Revision host.local",
      ],
    });
  });

  test("a decide_seat launch with no host capacity refuses config_missing", async () => {
    expect(await slotRefusal(conn.db, "local", null, [])).toMatchObject(
      missing,
    );
  });

  test("pod check with no host Revision reports no free slot and the next steps", async () => {
    const { orca, log } = replay(conn, [
      ok("check", empty(), ["--run", "run_1"]),
      ok("worker-list", workers([]), ["--run", "run_1"]),
    ]);
    const pass = await checkPass(conn.db, orca, null, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      capacity: null,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    expect(pass).toMatchObject({ ok: true, result: { free_slots: 0 } });
    expect(pass.ok && pass.result.nextSteps).toEqual(
      expect.arrayContaining([
        "host local has no active host Revision",
        "pod config apply specs/host/local.yaml --ticket K",
      ]),
    );
  });
});
