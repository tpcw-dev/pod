import { afterAll, beforeAll, expect, test } from "vitest";
import { BriefOutput } from "../../src/cli/brief.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import {
  applyConfig,
  audit,
  auditor,
  cliDeliveredPlan,
  cliReplay,
  decider,
  delivery,
  generation,
  implementTask,
  opensAuditor,
  opensDecider,
  planTask,
  questionFile,
  run,
  sent,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { seedHost } from "../db/seed.ts";
import { empty, message, started, workers } from "../db/run-fixture.ts";

const dir = "test/replay/plan-rework";
const processRef = "plan-rework@1";
const reworkTask = "task_plan_2";
const changes = [
  "split the schema migration from the backfill",
  "add a rollback step",
];

const rollout = {
  question: "Does the plan pass as written?",
  options: ["accept it", "send it back with changes"],
};

function proposal(
  id: string,
  decisionId: string,
  fields: Record<string, unknown>,
): unknown {
  return message(id, "decision_gate", {
    kind: "decision_proposal",
    dispatchId: decider,
    decisionId,
    round: 1,
    proposal: "one release with a rollback step",
    citations: ["story:abc"],
    ...fields,
  });
}

describeDb("plan rework", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig([
      `${dir}/policy.yaml`,
      `${dir}/crew.yaml`,
      `${dir}/process.yaml`,
      "test/replay/decision-states/process.yaml",
      "specs/decision/default.yaml",
    ]);
    await seedHost(conn.db);
  });
  afterAll(() => conn.close());

  async function pass(orca: readonly TempEntry[]) {
    const result = await cliReplay(
      conn,
      ["check", ...run, ...generation],
      orca,
    );
    expect(result.status, result.json.error?.message).toBe(0);
    return result.json.result ?? {};
  }

  async function decide(task: string, orca: readonly TempEntry[]) {
    const result = await cliReplay(
      conn,
      [
        "decide",
        questionFile(rollout),
        "--task",
        task,
        "--category",
        "architecture_choice",
        "--effect",
        "accept_plan",
        ...generation,
      ],
      orca,
    );
    expect(result.status, result.json.error?.message).toBe(0);
    return String(result.json.result?.["decision_id"]);
  }

  async function agreed(
    decisionId: string,
    fields: Record<string, unknown>,
    after: TempEntry[] = [],
    auditorOpens: readonly TempEntry[] = opensAuditor,
  ) {
    const proposed = await pass(
      delivery(
        `delivery_p_${decisionId}`,
        [proposal(`p_${decisionId}`, decisionId, fields)],
        [...auditorOpens],
      ),
    );
    const settled = await pass(
      delivery(
        `delivery_a_${decisionId}`,
        [audit(`a_${decisionId}`, decisionId, 1, "agree")],
        after,
      ),
    );
    expect(await conn.db.getDecision(decisionId)).toMatchObject({
      state: "agreed",
    });
    return { proposed, settled };
  }

  async function tasks() {
    return conn.sql<
      {
        task_id: string;
        step_id: string;
        state: string;
        rework_of: string | null;
        deps: string[];
      }[]
    >`select task_id, step_id, state, rework_of, deps from ledger.task order by created_at, task_id`;
  }

  async function receipts(verb: string): Promise<string[]> {
    const rows = await conn.sql<{ argv: string[] }[]>`
      select payload->'argv' as argv from ledger.event
      where type = 'receipt' and payload->'argv' ? ${verb} order by id`;
    return rows.map((row) => row.argv.join(" "));
  }

  test("an agreed plan rework creates a rework plan Task with the changes, then an agreed accept makes implement ready", async () => {
    await cliDeliveredPlan(conn, "TRK-1", processRef);
    const first = await decide(planTask, opensDecider);
    const { settled } = await agreed(first, { plan: "rework", changes }, [
      ok("task-create", { task: { id: reworkTask, status: "ready" } }, run),
    ]);
    const audited = (await receipts("send")).find((argv) =>
      argv.includes(`dispatch:${auditor}`),
    );
    expect(audited).toContain(`Plan: rework\nChanges:\n- ${changes[0]}`);
    expect(settled["nextSteps"]).not.toContainEqual(
      expect.stringContaining("proposal names no plan field"),
    );

    expect((await conn.db.getDecision(first))?.outcome).toMatchObject({
      result: "agreed",
      plan: "rework",
      changes,
    });
    expect(await tasks()).toEqual([
      expect.objectContaining({ task_id: planTask, state: "failed" }),
      expect.objectContaining({
        task_id: implementTask,
        step_id: "implement",
        state: "pending",
        deps: [reworkTask],
      }),
      expect.objectContaining({
        task_id: reworkTask,
        step_id: "plan",
        state: "ready",
        rework_of: planTask,
      }),
    ]);
    const spec = (await receipts("task-create")).at(-1) ?? "";
    expect(spec).toContain(`Agreed plan change from Decision ${first}`);
    for (const change of changes) expect(spec).toContain(`- ${change}`);

    const brief = runCli(["brief", "story:TRK-1"]);
    expect(brief.status, brief.json.error?.message).toBe(0);
    const [measured] =
      BriefOutput.parse(brief.json.result).stories[0]?.runs ?? [];
    expect(measured?.measurement.decisions).toContainEqual(
      expect.objectContaining({ decision_id: first, outcome: "reworked" }),
    );

    const launched = await cliReplay(
      conn,
      ["dispatch", "--task", reworkTask, "--seat", "plan-1", ...generation],
      [ok("worker-start", started("ctx_plan_2", reworkTask))],
    );
    expect(launched.status, launched.json.error?.message).toBe(0);
    await pass(
      delivery("delivery_plan_2", [
        message("msg_plan_2", "worker_done", {
          taskId: reworkTask,
          dispatchId: "ctx_plan_2",
          outcome: "succeeded",
        }),
      ]),
    );
    const second = await decide(reworkTask, [sent(decider)]);
    await agreed(second, { plan: "accept", changes: [] }, [], [sent(auditor)]);
    expect(await conn.db.getTask(reworkTask)).toMatchObject({ state: "done" });
    expect(await conn.db.getTask(implementTask)).toMatchObject({
      state: "ready",
    });
    expect(
      (await tasks()).filter((row) => row.step_id === "implement"),
    ).toHaveLength(1);
  }, 120_000);

  test("a proposal with no plan field passes the plan and the check result says so", async () => {
    await cliDeliveredPlan(conn, "TRK-2", processRef);
    const id = await decide(planTask, opensDecider);
    const { proposed } = await agreed(id, {});
    expect(proposed["nextSteps"]).toContain(
      `Decision ${id} round 1: proposal names no plan field; read it before pod dispatch`,
    );
    expect(await conn.db.getTask(planTask)).toMatchObject({ state: "done" });
    expect(await conn.db.getTask(implementTask)).toMatchObject({
      state: "ready",
    });
  });

  test("an agreed plan rework on a step with no rework edge holds the plan Task and says so on every pass", async () => {
    await cliDeliveredPlan(conn, "TRK-3", "decision-states@1");
    const id = await decide(planTask, opensDecider);
    const held = `Decision ${id} agreed a plan rework; step plan has no rework edge; Task ${planTask} is on hold; change it with pod decide --effect change_spec --supersedes`;
    const { settled } = await agreed(id, { plan: "rework", changes });
    expect(settled["nextSteps"]).toContain(held);
    expect(await conn.db.getTask(planTask)).toMatchObject({ state: "hold" });
    expect(await conn.db.getTask(implementTask)).toMatchObject({
      state: "pending",
    });
    expect(
      await pass([
        ok("check", empty(), run),
        ok("worker-list", workers([]), run),
      ]),
    ).toMatchObject({
      nextSteps: expect.arrayContaining([held]),
    });
  });
});
