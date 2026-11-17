import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  attentionPaused,
  dueCauses,
  recordAttentionDrains,
} from "../../src/core/run/attention-pause.ts";
import { drain } from "../../src/core/run/drain.ts";
import { hostDay } from "../../src/core/plan/clock.ts";
import {
  agendaOf,
  type BriefAgendaSlice,
} from "../../src/core/standup/agenda.ts";
import {
  recordStandup,
  type StandupInput,
} from "../../src/core/standup/record.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import {
  attention,
  lateEvening,
  seedLaunch,
  timezone,
} from "./launch-fixture.ts";
import { createRun } from "./run-fixture.ts";

const source: BriefAgendaSlice = {
  projects: [
    {
      project: "widgets",
      digest: {
        proposals: [
          { number: 1, theme: "tests", ruling: "open" },
          { number: 2, theme: "docs", ruling: "accept" },
        ],
      },
    },
  ],
  tick: null,
  plan: { hosts: [], refused: [] },
  groom: null,
  guardrails: [{ name: "drained", sunset_candidate: false }],
};

describeDb("pod standup", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  function input(over: Partial<StandupInput> = {}): StandupInput {
    return {
      host: "local",
      timezone,
      actor: "person:human",
      outcome: "done",
      reason: null,
      agenda: agendaOf(source),
      now: lateEvening,
      ...over,
    };
  }

  const standups = () =>
    conn.sql<
      { host: string; payload: Record<string, unknown> }[]
    >`select host, payload from ledger.event where type = 'standup'`;
  const standupOps = () =>
    conn.sql<
      { op_key: string }[]
    >`select op_key from ledger.operation where intent = 'standup'`;

  async function pauseTwoHosts() {
    await seedLaunch(conn, { policy: { attention }, now: lateEvening });
    await recordAttentionDrains(conn.db, {
      host: "local",
      timezone,
      actor: "seat:tick",
      now: lateEvening,
    });
    await conn.db.appendEvent({
      type: "drain",
      ts: lateEvening,
      host: "elsewhere",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: "drain:elsewhere",
      payload: {
        ended: false,
        op_key: "drain:elsewhere",
        scope: "host",
        host: "elsewhere",
        cause: "pause_at",
      },
      source: { kind: "tick", actor: "seat:tick" },
    });
  }

  test("done writes one standup event and ends the attention drain on every host", async () => {
    await pauseTwoHosts();
    expect(
      await attentionPaused(conn.db, "local", timezone, lateEvening),
    ).toMatchObject({ code: "attention_paused" });
    const done = await recordStandup(conn.db, input());
    expect(done).toMatchObject({
      day: hostDay(lateEvening, timezone),
      outcome: "done",
      reason: null,
      recorded: true,
      ended: ["elsewhere", "local"],
      op_key: expect.stringMatching(/^standup:/),
      sections: [
        { name: "digest", result: "open", open: ["widgets #1 tests"] },
        { name: "needs_human", result: "clear", open: [] },
        { name: "groom", result: "unknown", open: [] },
        { name: "plan", result: "clear", open: [] },
        { name: "guardrails", result: "clear", open: [] },
      ],
    });
    expect(done.nextSteps).toContain("digest has 1 open item");
    const rows = await standups();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      host: "local",
      payload: { outcome: "done", agenda_hash: done.agenda_hash },
    });
    for (const host of ["local", "elsewhere"])
      expect(
        await conn.db.latestHostEvent(host, "drain", { scope: "host" }),
      ).toMatchObject({
        payload: { ended: true },
        source: { verb: "standup done", actor: "person:human" },
      });
    expect(
      await attentionPaused(conn.db, "local", timezone, lateEvening),
    ).toBeNull();
  });

  test("an operator's Run drain stays in force through the standup", async () => {
    await pauseTwoHosts();
    await createRun(conn);
    const drained = await drain(conn.db, {
      run: "run_1",
      generation: 1,
      end: false,
      opKey: null,
      host: "local",
      now: () => lateEvening,
    });
    expect(drained).toMatchObject({ ok: true });
    await recordStandup(conn.db, input());
    expect((await conn.db.getRun("run_1"))?.state).toBe("drained");
    expect(await conn.db.latestEvent("run_1", "drain")).toMatchObject({
      payload: { ended: false },
    });
  });

  test("a second done the same day keeps the op key and records nothing", async () => {
    await pauseTwoHosts();
    const first = await recordStandup(conn.db, input());
    const again = await recordStandup(
      conn.db,
      input({ now: new Date(lateEvening.getTime() + 60_000) }),
    );
    expect(again).toMatchObject({
      recorded: false,
      op_key: first.op_key,
      outcome: "done",
      ended: first.ended,
    });
    expect(await standups()).toHaveLength(1);
    expect(await standupOps()).toEqual([{ op_key: first.op_key }]);
  });

  test("a skip on a day that has a done converges on the done", async () => {
    await pauseTwoHosts();
    const first = await recordStandup(conn.db, input());
    const skipped = await recordStandup(
      conn.db,
      input({ outcome: "skipped", reason: "travel" }),
    );
    expect(skipped).toMatchObject({
      recorded: false,
      outcome: "done",
      op_key: first.op_key,
    });
    expect(skipped.nextSteps).toContain(
      `the standup of ${first.day} is already recorded as done`,
    );
    expect(await standups()).toHaveLength(1);
  });

  test("concurrent done and skip on one day leave one event and one operation", async () => {
    await pauseTwoHosts();
    const both = await Promise.all([
      recordStandup(conn.db, input()),
      recordStandup(conn.db, input({ outcome: "skipped", reason: "travel" })),
    ]);
    expect(both.filter((each) => each.recorded)).toHaveLength(1);
    expect(await standups()).toHaveLength(1);
    expect(await standupOps()).toHaveLength(1);
  });

  test("skip records every section as not_reached with its reason", async () => {
    await pauseTwoHosts();
    const skipped = await recordStandup(
      conn.db,
      input({ outcome: "skipped", reason: "travel" }),
    );
    expect(skipped).toMatchObject({ recorded: true, reason: "travel" });
    expect(skipped.sections.map((each) => each.result)).toEqual(
      Array(5).fill("not_reached"),
    );
  });

  test("a non-person actor writes nothing", async () => {
    await pauseTwoHosts();
    await expect(
      recordStandup(conn.db, input({ actor: "seat:TPC-1/lead" })),
    ).rejects.toThrow(/person/);
    await expect(
      recordStandup(conn.db, input({ outcome: "skipped", reason: "" })),
    ).rejects.toThrow(/reason/);
    expect(await standups()).toHaveLength(0);
    expect(await standupOps()).toHaveLength(0);
  });

  test("after the day's standup the tick records no pause_at drain, and the standup counts as a person's event on every host", async () => {
    await seedLaunch(conn, { policy: { attention }, now: lateEvening });
    expect(
      (await dueCauses(conn.db, "elsewhere", timezone, lateEvening)).map(
        (due) => due.cause,
      ),
    ).toEqual(["pause_at", "unattended"]);
    await recordStandup(conn.db, input());
    expect(
      await dueCauses(conn.db, "elsewhere", timezone, lateEvening),
    ).toEqual([]);
    expect(
      await recordAttentionDrains(conn.db, {
        host: "local",
        timezone,
        actor: "seat:tick",
        now: lateEvening,
      }),
    ).toEqual([]);
  });

  test("pod standup prints the five sections; done and skip need a person and a reason", async () => {
    await seedLaunch(conn, { policy: { attention } });
    const shown = runCli(["standup"]);
    expect(shown.status).toBe(0);
    expect(shown.json.result).toMatchObject({
      agenda_hash: expect.any(String),
      sections: [
        { name: "digest" },
        { name: "needs_human" },
        { name: "groom", state: "unknown" },
        { name: "plan" },
        {
          name: "guardrails",
          state: "open",
          items: expect.arrayContaining(["drained: 0 in 30 days"]),
        },
      ],
    });
    const seat = runCli(["standup", "done"], { POD_SEAT: "TPC-1/lead" });
    expect(seat.status).toBe(3);
    expect(seat.json.error?.code).toBe("activation_needs_person");
    expect(runCli(["standup", "skip"]).status).toBe(2);
    expect(await standups()).toHaveLength(0);
    const skip = runCli(["standup", "skip", "--reason", "travel"]);
    expect(skip.status).toBe(0);
    expect(skip.json.result).toMatchObject({
      outcome: "skipped",
      recorded: true,
    });
    const done = runCli(["standup", "done"]);
    expect(done.json.result).toMatchObject({
      outcome: "skipped",
      recorded: false,
    });
  });

  test("a host with no active host Revision refuses before anything is written", async () => {
    const refused = runCli(["standup", "done"]);
    expect(refused.status).not.toBe(0);
    expect(refused.json.error?.code).toBe("config_missing");
    expect(await standups()).toHaveLength(0);
  });
});
