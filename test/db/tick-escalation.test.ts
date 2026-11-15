import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../src/core/config/canonical-json.ts";
import { failDecision } from "../../src/core/decide/advance.ts";
import { CloseReport } from "../../src/core/domain/close.ts";
import type { Kind } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { AttentionPort } from "../../src/core/operate/attention.ts";
import {
  operateSteps,
  runTick,
  type TickOutcome,
} from "../../src/core/operate/tick.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { closeRun, type CloseInput } from "../../src/core/run/close.ts";
import { renderState } from "../../src/core/state/render.ts";
import { buildState } from "../../src/core/state/view.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeGit } from "./close-ports.ts";
import { fakeTracker } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { createRun, events } from "./run-fixture.ts";
import { activeRevision, crewValue, hostValue, processValue } from "./seed.ts";

const t0 = new Date("2026-11-15T16:00:00.000Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

const offline: OrcaPort = {
  ...noCalls(),
  version: () => Promise.reject(new Error("no Orca call expected")),
};

const noWorkers: AttentionPort = {
  workers: () => Promise.reject(new Error("no worker-list expected")),
  capacity: 2,
  retry: () => Promise.reject(new Error("no retry expected")),
};

const p0Report = {
  leftovers: [
    { text: "main went red after the merge", area: "impl", p0: "main_red" },
  ],
};

describeDb("pod tick escalations and needs_human lines", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await clearDb(conn);
    await activeRevision(conn.db, "policy", "default", {
      gates: {},
      story_status: { done: "Done", human_wait: "In-review" },
    });
    await activeRevision(conn.db, "crew", "default", crewValue);
    await activeRevision(conn.db, "process", "impl", processValue);
    await activate("host", "local", hostValue(2));
    await activate("schedule", "default", {
      tick_minutes: 15,
      hold_minutes: 60,
    });
    await createRun(conn);
  });
  afterAll(() => conn.close());

  async function activate(kind: Kind, name: string, value: Json) {
    const revision = await storeRevision(conn.db, {
      ...envelope(kind, name, value),
      scope: "host",
      scope_ref: "local",
    });
    const activated = await conn.db.activate({
      scope: "host",
      scope_ref: "local",
      kind,
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: t0,
    });
    if (!activated.ok) throw new Error(`${kind} not activated`);
  }

  function ran(outcome: TickOutcome | Refused): TickOutcome {
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome;
  }

  function tick(now: Date) {
    return runTick(
      conn.db,
      {
        host: "local",
        writer: "local",
        actor: "person:human",
        now,
        triggers: [],
      },
      operateSteps(noWorkers),
    );
  }

  function closeInput(): CloseInput {
    const report = CloseReport.parse(p0Report);
    return {
      story: "S-1",
      provider: "linear",
      generation: 1,
      report,
      reportHash: sha256Hex(canonicalJson(report)),
      keepFilesReviewed: false,
      host: "local",
      worktreeStatus: () => ({ files: [], ahead: 0 }),
      now: () => minutes(1),
      tracker: fakeTracker(),
      codeHost: makeFixtureCodeHost(),
      git: fakeGit(),
      actor: "person:operator-1",
    };
  }

  async function close() {
    const outcome = await closeRun(
      conn.db,
      offline,
      receiptLog(conn.db, "local"),
      closeInput(),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
  }

  async function triggers() {
    return conn.sql<
      { id: number; run_id: string | null; payload: Record<string, unknown> }[]
    >`select id::int as id, run_id, payload from ledger.event where type = 'trigger' order by id`;
  }

  async function openDecision(id: string) {
    await conn.db.insertManifest({
      id: `man_${id}`,
      run_id: "run_1",
      task_id: null,
      decision_id: null,
      parent_id: null,
      references: [],
      tests: null,
      created_at: t0,
    });
    await conn.db.insertDecision({
      id,
      run_id: "run_1",
      task_id: null,
      category: "plan",
      effect: "accept_plan",
      question: "q",
      options: [],
      manifest_id: `man_${id}`,
      state: "round:1",
      outcome: null,
      reason: null,
      binding: "run",
      budget: {},
      spent: {},
      supersedes_decision_id: null,
      adoption: "pending",
      adoption_evidence: [],
      created_at: t0,
      closed_at: null,
    });
  }

  test("a p0 escalate from run close writes one orchestration trigger, and a re-run close writes none", async () => {
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    ran(await tick(t0));
    await close();
    const [escalated] = await events(conn, "escalate");
    const [row] = await conn.sql<{ id: number }[]>`
      select id::int as id from ledger.event where type = 'escalate'`;
    expect(escalated).toBeDefined();
    expect(await triggers()).toEqual([
      {
        id: expect.any(Number),
        run_id: "run_1",
        payload: {
          host: "local",
          source: "orchestration",
          trigger_id: `escalate:${row?.id}`,
        },
      },
    ]);
    await close();
    expect(await triggers()).toHaveLength(1);
  });

  test("the escalate trigger makes the next tick due at once, and the tick lists the escalation", async () => {
    await conn.db.setTaskState("task_b", "done");
    await conn.db.setTaskState("task_r", "done");
    ran(await tick(t0));
    expect(ran(await tick(minutes(2))).outcome).toBe("not due");
    await close();
    const [trigger] = await triggers();
    const next = ran(await tick(minutes(3)));
    expect(next.outcome).toBe("ran");
    expect(next.consumed).toEqual([trigger?.id]);
    expect(next.needs_human).toContainEqual(
      expect.objectContaining({
        kind: "escalation",
        run_id: "run_1",
        story: "S-1",
        text: "main went red after the merge",
      }),
    );
  });

  test("a Decision entering needs_human writes one trigger, and the next tick inside tick_minutes runs and lists it", async () => {
    ran(await tick(t0));
    await openDecision("dec_1");
    await conn.db.transaction((tx) =>
      failDecision(tx, { decision: "dec_1", at: minutes(1), host: "local" }),
    );
    expect(await triggers()).toEqual([
      {
        id: expect.any(Number),
        run_id: "run_1",
        payload: {
          host: "local",
          source: "orchestration",
          trigger_id: `decision:dec_1:needs_human:${minutes(1).toISOString()}`,
        },
      },
    ]);
    const next = ran(await tick(minutes(2)));
    expect(next.outcome).toBe("ran");
    expect(next.consumed).toHaveLength(1);
    expect(next.needs_human).toContainEqual(
      expect.objectContaining({
        kind: "decision_needs_human",
        decision_id: "dec_1",
        text: "Decision dec_1 needs a person: runtime-failure",
      }),
    );
    const [stored] = await conn.sql<{ payload: { needs_human: unknown[] } }[]>`
      select payload from ledger.event where type = 'tick' order by id desc limit 1`;
    expect(stored?.payload.needs_human).toEqual(next.needs_human);
  });

  test("pod state and pod brief show the newest tick's needs_human lines", async () => {
    await openDecision("dec_1");
    await conn.db.transaction((tx) =>
      failDecision(tx, { decision: "dec_1", at: minutes(1), host: "local" }),
    );
    const first = ran(await tick(t0));
    const state = await buildState(
      { repo: conn.db, host: "local", docs: null, now: () => minutes(2) },
      { story: null, project: null },
    );
    if (!state.ok) throw new Error(state.refusal.message);
    expect(state.view.needs_human.tick).toEqual({
      host: "local",
      tick_id: first.tick_id,
      event_id: first.event_id,
      at: t0.toISOString(),
      needs_human: first.needs_human,
    });
    expect(renderState(state.view)).toContain(
      `tick ${first.event_id} decision_needs_human story S-1 run_1`,
    );
    const brief = runCli(["brief"]);
    expect(brief).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: {
          tick: {
            host: "local",
            event_id: first.event_id,
            needs_human: first.needs_human,
          },
        },
      },
    });
  });

  test("a tick event written before needs_human existed parses with no lines", async () => {
    ran(await tick(t0));
    await conn.sql`
      insert into ledger.event (type, ts, host, payload, source)
      select 'tick', ts + interval '1 minute', host, payload - 'needs_human', source
      from ledger.event where type = 'tick'`;
    const state = await buildState(
      { repo: conn.db, host: "local", docs: null, now: () => minutes(2) },
      { story: null, project: null },
    );
    if (!state.ok) throw new Error(state.refusal.message);
    expect(state.view.needs_human.tick?.needs_human).toEqual([]);
  });
});
