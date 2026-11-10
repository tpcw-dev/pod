import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { ok } from "../orca/temp-fixtures.ts";
import {
  applyConfig,
  auditor,
  cliReplay,
  cliXlRun,
  decider,
  generation,
  oneSlotHome,
  seatOpens,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { workers } from "../db/run-fixture.ts";

const dir = "test/replay/xl-takeover";
const newDecider = "ctx_new_decider";

describeDb("xl-takeover", () => {
  let conn: Connection;
  const home = oneSlotHome("keeper");
  const env = { POD_HOME: home };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig(
      [
        `${dir}/policy.yaml`,
        `${dir}/crew.yaml`,
        `${dir}/process.yaml`,
        "specs/decision/default.yaml",
      ],
      env,
    );
  });
  afterAll(() => conn.close());

  test("impl-xlarge@1 at capacity 1: a stopped decider is taken over by a new decider with the restore view, and the auditor keeps its Dispatch", async () => {
    const created = await cliXlRun(conn, "TRK-1", env);
    expect(created).toMatchObject({
      coordinator_dispatch_id: decider,
    });
    const auditorBefore = await conn.db.getDispatch(auditor);

    const taken = await cliReplay(
      conn,
      ["takeover", "story:TRK-1", ...generation],
      [
        ok(
          "run-show",
          {
            run: {
              id: "run_1",
              objective: "Pod Run for story:TRK-1",
              coordinator_handle: `term_${decider}`,
              consumer_generation: 1,
              legacy: 0,
            },
          },
          ["--id", "run_1"],
        ),
        ok(
          "worker-list",
          workers([
            {
              dispatchId: decider,
              taskId: `orca_${decider}`,
              workerState: "stopped",
            },
          ]),
          ["--run", "run_1"],
        ),
        ...seatOpens("decider", newDecider, "m-2"),
      ],
      { ...env, POD_COORDINATOR: "" },
    );
    expect(taken.status, taken.json.error?.message).toBe(0);
    const viewPath = join(home, "restore", "run_1-2.html");
    expect(taken.json.result).toMatchObject({
      owner_generation: 2,
      previous_coordinator: decider,
      coordinator_dispatch_id: newDecider,
      coordinator: `term_${newDecider}`,
      view_path: viewPath,
    });
    expect(existsSync(viewPath)).toBe(true);

    expect(await conn.db.getRun("run_1")).toMatchObject({
      owner_generation: 2,
      coordinator_dispatch_id: newDecider,
      coordinator: `term_${newDecider}`,
    });
    expect(await conn.db.getDispatch(decider)).toMatchObject({
      settlement: "stopped",
      activity: "settled",
    });
    expect(await conn.db.getDispatch(newDecider)).toMatchObject({
      role: "decider",
      settlement: "open",
      activity: "running",
    });
    expect(await conn.db.getDispatch(auditor)).toEqual(auditorBefore);
    const [seat] = await conn.sql<{ spec: string }[]>`
      select result_ref ->> 'spec' as spec from ledger.operation
      where intent = 'decide_seat'
        and result_ref -> 'result' ->> 'dispatch_id' = ${newDecider}`;
    expect(seat?.spec).toContain(viewPath);
    expect(seat?.spec).toContain("--generation 2");
  });
});
