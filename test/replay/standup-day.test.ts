import { afterAll, beforeAll, expect, test } from "vitest";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { guardrailCodes } from "../../src/cli/errors.ts";
import { readGuardrails } from "../../src/core/brief/guardrails.ts";
import { digestBrief } from "../../src/core/digest/brief.ts";
import { postDigest } from "../../src/core/digest/post.ts";
import { addLearning } from "../../src/core/learning/add.ts";
import { groomQueue } from "../../src/core/plan/candidates.ts";
import { planHost } from "../../src/core/plan/host.ts";
import { planDigest } from "../../src/core/plan/plan.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { operateSteps, runTick } from "../../src/core/operate/tick.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import type { StoryRef } from "../../src/core/ports/tracker.ts";
import { agendaOf, standupOf } from "../../src/core/standup/agenda.ts";
import { recordStandup } from "../../src/core/standup/record.ts";
import { newestTickLines } from "../../src/core/brief/counters.ts";
import { fakeGit } from "../db/close-ports.ts";
import { fakeTracker, listedStory, trackerStory } from "../db/fake-tracker.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { clearDb, describeDb, openDb, resetDb } from "../db/helpers.ts";
import {
  attention,
  lateEvening,
  morning,
  projectValue,
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
        groom: null,
        guardrails: [],
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

  test("the next day's agenda fills all five sections from the ledger and the tracker", async () => {
    const nextDay = new Date("2026-11-17T15:00:00.000Z");
    const now = () => nextDay;
    const added = await addLearning(conn.db, {
      row: {
        source_story: "S-1",
        evidence_refs: ["pr:1"],
        text: "the launch waited on the sitting",
        adoption: "new",
        area: "process",
        project_id: null,
        kind: "lead",
        reporter: "lead",
      },
      host: "local",
      now,
    });
    if (!added.ok) throw new Error(added.refusal.message);
    const posted = await postDigest(conn.db, {
      project: null,
      proposals: [
        {
          theme: "attention",
          text: "remind before pause_at",
          learning_ids: [added.id],
          evidence_refs: ["pr:1"],
        },
      ],
      host: "local",
      now,
    });
    if (!posted.ok) throw new Error(posted.refusal.message);
    await conn.db.appendEvent({
      type: "tick",
      ts: nextDay,
      host: "local",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: {
        host: "local",
        tick_id: "tick-next",
        actor: "seat:tick",
        schedule_revision: "schedule",
        plan_event: null,
        overrides: [],
        triggers: [],
        steps: [],
        launch: [],
        refuse: [],
        needs_human: [
          {
            kind: "run_hold",
            run_id: "run-1",
            story: "S-1",
            task_id: null,
            dispatch_id: null,
            decision_id: null,
            event_id: null,
            since: nextDay.toISOString(),
            text: "Run run-1 is on hold",
          },
        ],
      },
      source: { kind: "command", verb: "tick" },
    });
    const tracker = fakeTracker();
    tracker.listings[projectValue.tracker.project_id] = [
      listedStory({
        ref: { provider: "linear", external_id: "S-9" },
        title: "Sort the queue",
      }),
    ];
    const context = await planHost(conn.db, "local", nextDay);
    if (!context.ok) throw new Error(context.refusal.message);
    const plan = await planDigest(conn.db, "local", nextDay);
    if (!plan.ok) throw new Error(plan.refusal.message);
    const tickLines = await newestTickLines(conn.db, "local");
    const standup = standupOf(
      {
        projects: [
          {
            project: "global",
            digest: await digestBrief(conn.db, null, now),
          },
        ],
        tick: tickLines,
        plan: {
          hosts: [
            {
              host: "local",
              ranked: plan.published?.ranked ?? [],
              published: plan.published,
            },
          ],
          refused: [],
        },
        guardrails: await readGuardrails(conn.db, guardrailCodes, nextDay),
      },
      await groomQueue({ repo: conn.db, tracker, context, project: null }),
    );
    expect(standup.sections.map((each) => [each.name, each.state])).toEqual([
      ["digest", "open"],
      ["needs_human", "open"],
      ["groom", "open"],
      ["plan", "open"],
      ["guardrails", "open"],
    ]);
    expect(standup.groom).toEqual({
      stories: [
        { project: "widgets", external_id: "S-9", title: "Sort the queue" },
      ],
      proposals: "unknown",
      partial: [],
    });
    const done = await recordStandup(conn.db, {
      host: "local",
      timezone,
      actor: "person:human",
      outcome: "done",
      reason: null,
      agenda: standup.sections,
      now: nextDay,
    });
    expect(done).toMatchObject({ recorded: true, day: "2026-11-17" });
    expect(done.sections.every((each) => each.result === "open")).toBe(true);
  });
});
