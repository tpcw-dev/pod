import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, type CheckInput } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { decisionLimits } from "../../src/core/config/limits.ts";
import { openDecision, type DecideInput } from "../../src/core/decide/open.ts";
import { revisionId } from "../../src/core/config/canonical-json.ts";
import type { NewRevision, Revision } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { fixtures, ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { clearDb, runCli, type CliResult } from "./helpers.ts";
import {
  batch,
  dispatched,
  empty,
  message,
  replay,
  started,
  workers,
} from "./run-fixture.ts";
import { activeRevision } from "./seed.ts";

export const planTask = "task_plan";
export const implementTask = "task_impl";
export const planner = "ctx_plan";
export const decider = "ctx_decider";
export const auditor = "ctx_auditor";
export const run = ["--run", "run_1"];
export const ack = (id: string) => ["--run", "run_1", "--ack", id];

const hold = ["timeout", "cancel", "unknown"];

export const decisionCrew = {
  seats: [
    { id: "plan-1", roles: ["planner"], runtime: "claude", model: "m-1" },
    { id: "dev-1", roles: ["developer"], runtime: "claude", model: "m-1" },
    { id: "dec-1", roles: ["decider"], runtime: "claude", model: "m-2" },
    {
      id: "aud-1",
      roles: ["auditor"],
      runtime: "codex",
      independent_of: ["dec-1"],
    },
  ],
};

export const planProcess = {
  summary: "a plan agreed by the decision pair, then the build",
  selector: { stage: "impl", size: ["xl"] },
  roles: ["planner", "developer"],
  steps: [
    {
      id: "plan",
      type: "worker",
      role: "planner",
      produces: ["plan"],
      decision: "plan",
    },
    {
      id: "implement",
      type: "worker",
      role: "developer",
      needs: ["plan"],
      spec: "Build it.",
    },
  ],
  edges: [
    { from: "plan", on: "agreed", to: "implement" },
    { from: "plan", on: "cancelled", to: "hold" },
    { from: "plan", on: hold, to: "hold" },
    { from: "implement", on: "done", to: "done" },
    { from: "implement", on: hold, to: "hold" },
  ],
  limits: { attempts_per_task: 3, rework_per_lineage: 3 },
  escalation: { to: "decision-pair" },
};

export function defaultTemplates(): Json {
  return (
    parse(readFileSync("specs/decision/default.yaml", "utf8")) as {
      value: Json;
    }
  ).value;
}

export async function seedDecision(
  conn: Connection,
  policy: Json = { gates: [] },
  crew: Json = decisionCrew,
): Promise<Revision> {
  await clearDb(conn);
  await activeRevision(conn.db, "policy", "default", policy);
  await activeRevision(conn.db, "crew", "default", crew);
  await activeRevision(conn.db, "process", "plan", planProcess);
  return activeRevision(conn.db, "decision", "default", defaultTemplates());
}

export function checkInput(over: Partial<CheckInput> = {}): CheckInput {
  return {
    run: "run_1",
    generation: 1,
    host: "local",
    capacity: 2,
    leaseSeconds: launchLeaseSeconds,
    now: () => new Date(),
    ...over,
  };
}

export async function dispatchedPlan(
  conn: Connection,
  policy: Json = { gates: [] },
): Promise<Revision> {
  const templates = await seedDecision(conn, policy);
  const created = replay(conn, [
    ok("run-create", { run: { id: "run_1" } }),
    ok("task-create", { task: { id: planTask, status: "ready" } }),
    ok("task-create", { task: { id: implementTask, status: "pending" } }),
  ]);
  const made = await runCreate(conn.db, created.orca, null, created.log, {
    story: "S-9",
    process: { name: "plan", rev: 1 },
    size: "xl",
    stage: "impl",
    coordinator: "session-1",
    host: "local",
    provider: "linear",
    command: "pod run create story:S-9",
    now: () => new Date(),
  });
  if (!made.ok) throw new Error(made.refusal.message);
  await dispatched(conn, planner, { task: planTask, seat: "plan-1" });
  return templates;
}

export function taskSpec(
  task: { lineage_id: string; run_id: string },
  spec = "Plan it with the agreed error envelope.",
): NewRevision {
  const envelope = {
    kind: "task" as const,
    name: task.lineage_id,
    schema_version: 1,
    scope: "run" as const,
    scope_ref: task.run_id,
    parent: null,
    value: { spec },
  };
  return {
    ...envelope,
    id: revisionId(envelope),
    actor: "pod decide",
    reason: "pod decide --effect change_spec",
  };
}

export function refusedReply(
  verb: string,
  code: string,
  argv: string[] = [],
): TempEntry {
  return {
    verb,
    argv,
    exitCode: 1,
    stdout: JSON.stringify({
      ok: false,
      error: { code, message: `${verb} refused`, data: {} },
    }),
  };
}

export async function deliveredPlan(
  conn: Connection,
  policy: Json = { gates: [] },
  crew: Json = decisionCrew,
): Promise<Revision> {
  const templates = await seedDecision(conn, policy, crew);
  const created = replay(conn, [
    ok("run-create", { run: { id: "run_1" } }),
    ok("task-create", { task: { id: planTask, status: "ready" } }),
    ok("task-create", { task: { id: implementTask, status: "pending" } }),
  ]);
  const made = await runCreate(conn.db, created.orca, null, created.log, {
    story: "S-9",
    process: { name: "plan", rev: 1 },
    size: "xl",
    stage: "impl",
    coordinator: "session-1",
    host: "local",
    provider: "linear",
    command: "pod run create story:S-9",
    now: () => new Date(),
  });
  if (!made.ok) throw new Error(made.refusal.message);
  await dispatched(conn, planner, { task: planTask, seat: "plan-1" });
  const delivered = replay(conn, [
    ok(
      "check",
      batch("delivery_plan", [
        message("msg_plan", "worker_done", {
          taskId: planTask,
          dispatchId: planner,
          outcome: "succeeded",
        }),
      ]),
      run,
    ),
    ok("check", empty("delivery_plan"), ack("delivery_plan")),
    ok(
      "worker-list",
      workers([
        { dispatchId: planner, taskId: planTask, workerState: "succeeded" },
      ]),
      run,
    ),
  ]);
  const checked = await checkPass(
    conn.db,
    delivered.orca,
    null,
    delivered.log,
    checkInput(),
  );
  if (!checked.ok) throw new Error(checked.refusal.message);
  return templates;
}

export const seatTask = (role: string): TempEntry =>
  ok("task-create", { task: { id: `orca_${role}`, status: "ready" } }, [
    "--run",
    "run_1",
  ]);

export function seatStarted(dispatchId: string, model = "m-2"): unknown {
  return {
    dispatchId,
    state: "ready",
    taskId: `orca_${dispatchId}`,
    terminalHandle: `term_${dispatchId}`,
    launch: {
      requested: { agent: "claude", model },
      effective: { agent: "claude", model },
    },
  };
}

export const sent = (to: string): TempEntry =>
  ok("send", { message: { id: `sent_${to}` } }, ["--to", `dispatch:${to}`]);

export function decideInput(
  templates: Revision | null,
  over: Partial<DecideInput> = {},
): DecideInput {
  return {
    task: planTask,
    category: "architecture_choice",
    effect: "accept_plan",
    question: "Which rollout should the plan use?",
    options: ["one release", "two releases with a rollback step"],
    generation: 1,
    opKey: null,
    host: "local",
    capacity: 2,
    templates,
    limits: decisionLimits,
    now: () => new Date(),
    ...over,
  };
}

export async function opened(
  conn: Connection,
  templates: Revision,
): Promise<string> {
  const { orca, log } = replay(conn, [
    seatTask("decider"),
    ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
    sent(decider),
  ]);
  const outcome = await openDecision(
    conn.db,
    orca,
    log,
    decideInput(templates),
  );
  orca.assertDone();
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.result.decision_id;
}

export function proposal(
  id: string,
  decisionId: string,
  round: number,
  citations: string[] = ["story:abc"],
  text = `round ${round} proposal`,
): unknown {
  return message(id, "decision_gate", {
    kind: "decision_proposal",
    dispatchId: decider,
    decisionId,
    round,
    proposal: text,
    citations,
  });
}

export function audit(
  id: string,
  decisionId: string,
  round: number,
  stance: string,
  from = auditor,
  reasons = [`reason ${round}`],
): unknown {
  return message(id, "decision_gate", {
    kind: "decision_audit",
    dispatchId: from,
    decisionId,
    round,
    stance,
    reasons,
    points_of_disagreement: stance === "agree" ? [] : [`point ${round}`],
  });
}

export function evidence(
  id: string,
  decisionId: string,
  round: number,
  references: unknown[] = [
    { source: "git_status", revision: "abc123", excerpt: "clean tree" },
  ],
): unknown {
  return message(id, "decision_gate", {
    kind: "decision_evidence",
    dispatchId: decider,
    decisionId,
    round,
    references,
  });
}

export async function clearRuns(conn: Connection): Promise<void> {
  const tables = await conn.sql<{ name: string }[]>`
    select format('%I.%I', schemaname, tablename) as name
    from pg_tables where schemaname = 'ledger'`;
  await conn.sql.unsafe(
    `truncate config.snapshot, ${tables.map((table) => table.name).join(", ")} cascade`,
  );
  await conn.sql`delete from config.activation where scope = 'run'`;
}

export function applyConfig(files: readonly string[]): void {
  for (const file of files) {
    const applied = runCli([
      "config",
      "apply",
      file,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(applied.status, applied.json.error?.message ?? file).toBe(0);
  }
}

export function questionFile(body: object): string {
  const path = join(mkdtempSync(join(tmpdir(), "pod-question-")), "q.yaml");
  writeFileSync(path, stringify(body));
  return path;
}

async function orcaReceipts(conn: Connection): Promise<number> {
  const [row] = await conn.sql<{ n: number }[]>`
    select count(*)::int as n from ledger.event
    where type = 'receipt' and payload ? 'argv'`;
  return row?.n ?? 0;
}

export async function cliReplay(
  conn: Connection,
  args: string[],
  orca: readonly TempEntry[] = [],
  env: Record<string, string> = {},
): Promise<CliResult> {
  const before = await orcaReceipts(conn);
  const result = runCli(args, {
    POD_COORDINATOR: "session-1",
    POD_ORCA_FIXTURES: fixtures([...orca, ok("no-further-call", {})]),
    ...env,
  });
  expect(
    await orcaReceipts(conn),
    `${args.join(" ")} replays every fixture`,
  ).toBe(before + orca.length);
  return result;
}

export const generation = ["--generation", "1"];

export async function cliDeliveredPlan(
  conn: Connection,
  story: string,
  processRef: string,
): Promise<void> {
  await clearRuns(conn);
  const created = await cliReplay(
    conn,
    [
      "run",
      "create",
      `story:${story}`,
      "--process",
      processRef,
      "--size",
      "xl",
      "--stage",
      "impl",
    ],
    [
      ok("run-create", { run: { id: "run_1" } }),
      ok("task-create", { task: { id: planTask, status: "ready" } }),
      ok("task-create", { task: { id: implementTask, status: "pending" } }),
    ],
  );
  expect(created.status, created.json.error?.message).toBe(0);
  const launched = await cliReplay(
    conn,
    ["dispatch", "--task", planTask, "--seat", "plan-1", ...generation],
    [ok("worker-start", started(planner, planTask))],
  );
  expect(launched.status, launched.json.error?.message).toBe(0);
  const delivered = await cliReplay(
    conn,
    ["check", ...run, ...generation],
    [
      ok(
        "check",
        batch("delivery_plan", [
          message("msg_plan", "worker_done", {
            taskId: planTask,
            dispatchId: planner,
            outcome: "succeeded",
          }),
        ]),
        run,
      ),
      ok("check", empty("delivery_plan"), ack("delivery_plan")),
      ok(
        "worker-list",
        workers([
          { dispatchId: planner, taskId: planTask, workerState: "succeeded" },
        ]),
        run,
      ),
    ],
  );
  expect(delivered.status, delivered.json.error?.message).toBe(0);
}

export const opensDecider = [
  seatTask("decider"),
  ok("worker-start", seatStarted(decider), ["--task", "orca_decider"]),
  sent(decider),
];

export const opensAuditor = [
  seatTask("auditor"),
  ok("worker-start", seatStarted(auditor, "m-3"), ["--task", "orca_auditor"]),
  sent(auditor),
];

export function decideArgs(
  file: string,
  effect = "accept_plan",
  more: string[] = [],
): string[] {
  return [
    "decide",
    file,
    "--task",
    planTask,
    "--category",
    "architecture_choice",
    "--effect",
    effect,
    ...generation,
    ...more,
  ];
}

export function delivery(
  key: string,
  messages: unknown[],
  after: TempEntry[] = [],
): TempEntry[] {
  return [
    ok("check", batch(key, messages), run),
    ok("check", empty(key), ack(key)),
    ...after,
    ok("worker-list", workers([]), run),
  ];
}
