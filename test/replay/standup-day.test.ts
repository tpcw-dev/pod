import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { operateSteps, runTick } from "../../src/core/operate/tick.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import type { StoryRef } from "../../src/core/ports/tracker.ts";
import { agendaOf } from "../../src/core/standup/agenda.ts";
import { recordStandup } from "../../src/core/standup/record.ts";
import { fakeGit } from "../db/close-ports.ts";
import { fakeTracker, trackerStory } from "../db/fake-tracker.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import {
  attention,
  lateEvening,
  morning,
  seedLaunch,
  timezone,
} from "../db/launch-fixture.ts";
import { noCalls } from "../orca/temp-fixtures.ts";

const dir = process.env["POD_ORCA_FIXTURES"] ?? "fixtures/orca/standup-day";
const minutes = (n: number) => new Date(lateEvening.getTime() + n * 60_000);

describeDb("standup-day", () => {
  let conn: Connection;
  let trigger = 0;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await clearDb(conn);
    await seedLaunch(conn, { policy: { attention }, now: lateEvening });
    const schedule = await storeRevision(conn.db, {
      ...envelope("schedule", "default", {
        tick_minutes: 15,
        hold_minutes: 60,
      }),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind: "schedule",
      name: "default",
      expected: null,
      revision_id: schedule.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: morning,
    });
    if (!activated.ok) throw new Error("schedule not activated");
  });
  afterAll(() => conn.close());

  async function tick(at: Date, orca: OrcaPort) {
    trigger += 1;
    const tracker = fakeTracker();
    const idle = () => Promise.resolve({ result: "ok" as const, detail: null });
    const steps = operateSteps({
      orca,
      tracker: {
        ...tracker,
        readStory: (ref: StoryRef) => {
          tracker.story = trackerStory({ ref });
          return tracker.readStory(ref);
        },
      },
      log: receiptLog(conn.db, "local"),
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      worktreeStatus: () => null,
      gitStatus: () => "## main",
      provider: "linear",
      leaseSeconds: launchLeaseSeconds,
    }).map((step) =>
      ["observe", "close", "attention"].includes(step.name)
        ? { ...step, run: idle }
        : step,
    );
    const outcome = await runTick(
      conn.db,
      {
        host: "local",
        writer: "local",
        actor: "seat:tick",
        now: at,
        triggers: [{ source: "operator", trigger_id: `t-${trigger}` }],
      },
      steps,
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome;
  }

  const sitting = (at: Date) =>
    recordStandup(conn.db, {
      host: "local",
      timezone,
      actor: "person:human",
      outcome: "done",
      reason: null,
      agenda: agendaOf({
        projects: [],
        tick: null,
        plan: { hosts: [], refused: [] },
      }),
      now: at,
    });

  test("past pause_at the launch refuses attention_paused; after pod standup done the next tick launches; a second done records nothing", async () => {
    const paused = await tick(lateEvening, noCalls());
    expect(paused.launch).toEqual([]);
    expect(paused.refuse).toMatchObject([
      { story: "S-1", code: "attention_paused" },
    ]);

    const done = await sitting(minutes(1));
    expect(done).toMatchObject({ recorded: true, ended: ["local"] });

    const log = receiptLog(conn.db, "local");
    const orca = makeReplayOrca({ dir, sink: log.sink });
    const resumed = await tick(minutes(2), orca);
    expect(resumed.launch).toMatchObject([{ story: "S-1" }]);
    expect(
      resumed.steps.find((each) => each.step === "launch")?.detail,
    ).toMatchObject({ drains: [] });

    const again = await sitting(minutes(3));
    expect(again).toMatchObject({ recorded: false, op_key: done.op_key });
    const [count] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event where type = 'standup'`;
    expect(count?.n).toBe(1);
  });
});
