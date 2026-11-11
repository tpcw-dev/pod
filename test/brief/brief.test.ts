import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { snapshotHash } from "../../src/core/config/canonical-json.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Run, Story } from "../../src/core/domain/ledger.ts";
import { waitingOn } from "../../src/core/process/waiting.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { dbUrl, describeDb, openDb, podHome, resetDb } from "../db/helpers.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const at = new Date("2026-10-26T00:00:00.000Z");
const mirror = join(podHome, "mirror");

function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function runBrief(
  cwd: string,
  args: string[],
  home = podHome,
): { status: number | null; stdout: string } {
  return spawnSync(
    join(repo, "node_modules/.bin/tsx"),
    [join(repo, "src/cli/index.ts"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, POD_DB_URL: dbUrl(), POD_HOME: home },
    },
  );
}

describeDb("pod brief", () => {
  let conn: Connection;
  const cwd = mkdtempSync(join(tmpdir(), "pod-brief-"));

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    const story: Story = {
      provider: "tracker",
      external_id: "S-1",
      size: "s",
      stage: "a<b",
      run_id: "run-1",
      dependencies: [],
      synced_at: at,
      status: null,
      title: null,
      kickoff_line: null,
    };
    const run: Run = {
      run_id: "run-1",
      story_provider: "tracker",
      story_external_id: "S-1",
      host: "local",
      coordinator: "session-1",
      owner_generation: 1,
      snapshot_hash: "pending",
      state: "active",
      created_at: at,
      coordinator_dispatch_id: null,
    };
    await conn.db.upsertStory(story);
    await conn.db.insertRun(run);
    const crew = envelope("crew", "crew", { seats: [] });
    const process = envelope("process", "flow", { steps: ["build"] });
    const policy = envelope("policy", "policy", { gates: ["review"] });
    const crewRow = await storeRevision(conn.db, crew);
    const processRow = await storeRevision(conn.db, process);
    const policyRow = await storeRevision(conn.db, policy);
    const projectCrew = await storeRevision(conn.db, {
      ...crew,
      scope: "project",
      scope_ref: "app",
    });
    for (const row of [crewRow, processRow, policyRow, projectCrew])
      await conn.db.activate({
        scope: row.scope,
        scope_ref: row.scope_ref,
        kind: row.kind,
        name: row.name,
        expected: null,
        revision_id: row.id,
        bundle_id: null,
        activated_by: "operator",
        activated_at: at,
      });
    const gateMap = { review: "crew" };
    const hash = snapshotHash(
      { crew: crewRow.id, process: processRow.id, policy: policyRow.id },
      gateMap,
    );
    await conn.db.insertSnapshot({
      run_id: "run-1",
      crew_revision_id: crewRow.id,
      process_revision_id: processRow.id,
      policy_revision_id: policyRow.id,
      effective_gate_map: gateMap,
      hash,
      pinned_at: at,
      project: null,
      profile: null,
    });
    const spec = await storeRevision(
      conn.db,
      envelope("task", "lineage-1", { goal: "build" }),
    );
    await conn.db.insertTask({
      task_id: "task-1",
      run_id: "run-1",
      step_id: "build",
      lineage_id: "lineage-1",
      role: "developer",
      deps: [],
      spec_revision_id: spec.id,
      rework_of: null,
      state: "ready",
      created_at: at,
    });
    await conn.db.insertOperation({
      op_key: "op-d",
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
    await conn.db.insertDispatch({
      dispatch_id: "ctx-1",
      task_id: "task-1",
      decision_id: null,
      run_id: "run-1",
      seat: "seat-a",
      role: "developer",
      requested_launch: {},
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: "op-d",
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity: "running",
      manifest_id: null,
      prompt_bytes: null,
    });
    mkdirSync(join(mirror, "crew"), { recursive: true });
    mkdirSync(join(mirror, "process"), { recursive: true });
    mkdirSync(join(mirror, "policy"), { recursive: true });
    writeFileSync(join(mirror, "crew/crew.yaml"), stringify(crew));
    writeFileSync(join(mirror, "process/flow.yaml"), stringify(process));
    writeFileSync(
      join(mirror, "policy/policy.yaml"),
      stringify(envelope("policy", "policy", { gates: ["other"] })),
    );
    mkdirSync(join(cwd, "specs/crew/project/app"), { recursive: true });
    writeFileSync(
      join(cwd, "specs/crew/project/app/crew.yaml"),
      stringify({ ...crew, scope: "project", scope_ref: "app" }),
    );
    mkdirSync(join(cwd, "specs/policy"), { recursive: true });
    writeFileSync(join(cwd, "specs/policy/policy.yaml"), stringify(policy));
  });
  afterAll(() => conn.close());

  test("brief prints JSON, writes the same JSON as HTML, and marks a mirror stale", async () => {
    const [eventsBefore] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event`;
    const [opsBefore] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation`;
    const html = join(cwd, "brief.html");
    const result = runBrief(cwd, ["brief", "story:S-1", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      result: {
        stories: { stage: string }[];
        drift: Record<string, unknown>[];
        nextSteps?: string[];
      };
    };
    expect(parsed.ok).toBe(true);
    const file = readFileSync(html, "utf8");
    expect(file).not.toContain("<script");
    expect(file).not.toMatch(/\ssrc=/);
    expect(file).not.toContain("url(");
    const pre = file.match(/<pre id="brief-json">([\s\S]*)<\/pre>/);
    expect(unescapeHtml(pre?.[1] ?? "")).toBe(JSON.stringify(parsed.result));
    expect(parsed.result.stories[0]?.stage).toBe("a<b");
    expect(result.stdout).toContain('"waiting_on":null');
    expect(parsed.result.stories[0]).not.toHaveProperty("drift");
    expect(
      parsed.result.drift.map(({ kind, name, scope, path, mark }) => ({
        kind,
        name,
        scope,
        path,
        mark,
      })),
    ).toEqual([
      {
        kind: "crew",
        name: "crew",
        scope: "project:app",
        path: join(mirror, "crew/project/app/crew.yaml"),
        mark: "mirror stale",
      },
      {
        kind: "policy",
        name: "policy",
        scope: "global",
        path: join(mirror, "policy/policy.yaml"),
        mark: "mirror stale",
      },
    ]);
    expect(parsed.result.drift[1]).toMatchObject({ ref: "policy.policy@1" });
    expect(parsed.result.nextSteps).toEqual(["pod config export --all"]);
    expect(file).toContain('<table id="mirror-stale">');
    expect(file).toContain(`<td>${join(mirror, "policy/policy.yaml")}</td>`);
    const [eventsAfter] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event`;
    const [opsAfter] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation`;
    expect(eventsAfter?.n).toBe(eventsBefore?.n);
    expect(opsAfter?.n).toBe(opsBefore?.n);
  });

  test("a mirror_dir that is a file leaves brief running, with every active Revision mirror stale", () => {
    const file = join(cwd, "not-a-dir");
    writeFileSync(file, "x\n");
    const home = mkdtempSync(join(tmpdir(), "pod-home-"));
    writeFileSync(
      join(home, "host.yaml"),
      `${readFileSync(join(podHome, "host.yaml"), "utf8")}mirror_dir: ${file}\n`,
    );
    const result = runBrief(cwd, ["brief", "story:S-1"], home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      result: { drift: { ref: string; path: string; mark: string }[] };
    };
    expect(parsed.result.drift).toHaveLength(4);
    for (const item of parsed.result.drift) {
      expect(item.mark).toBe("mirror stale");
      expect(item.path.startsWith(`${file}/`)).toBe(true);
    }
  });

  test("brief warns when a credential the credentials file holds is still exported", () => {
    const plain = JSON.parse(runBrief(cwd, ["brief", "story:S-1"]).stdout) as {
      result: Record<string, unknown>;
    };
    expect(plain.result["nextSteps"]).toEqual(["pod config export --all"]);
    const home = mkdtempSync(join(tmpdir(), "pod-home-"));
    copyFileSync(join(podHome, "host.yaml"), join(home, "host.yaml"));
    writeFileSync(join(home, "credentials"), `POD_DB_URL=${dbUrl()}\n`, {
      mode: 0o600,
    });
    const result = runBrief(cwd, ["brief", "story:S-1"], home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      result: { nextSteps?: string[] };
    };
    expect(parsed.result.nextSteps).toEqual([
      "POD_DB_URL is exported in this session; Seats inherit it. Remove it from the session environment",
      "pod config export --all",
    ]);
  });

  test("brief lists delivered tests in JSON and as a two-row table", async () => {
    await conn.db.insertManifest({
      id: "manifest-tests",
      run_id: "run-1",
      task_id: "task-1",
      decision_id: null,
      parent_id: null,
      references: [],
      tests: [
        {
          command: "pnpm test",
          exit_code: 0,
          seconds: 1,
          timeout_seconds: null,
        },
        {
          command: "timeout 60 pnpm test",
          exit_code: 1,
          seconds: 2.5,
          timeout_seconds: 60,
        },
      ],
      created_at: at,
    });
    await conn.sql`
      update ledger.dispatch
      set manifest_id = 'manifest-tests'
      where dispatch_id = 'ctx-1'`;
    const html = join(cwd, "tests.html");
    const result = runBrief(cwd, ["brief", "story:S-1", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toMatchObject({
      stories: [
        {
          counters: {
            coordinator_operations: 1,
            recovery_steps: 0,
            retries: 0,
            rework_tasks: 0,
            hand_filled: 0,
          },
          runs: [
            {
              counters: {
                coordinator_operations: 1,
                recovery_steps: 0,
                retries: 0,
                rework_tasks: 0,
                hand_filled: 0,
              },
              dispatches: [
                {
                  dispatch_id: "ctx-1",
                  tests: [
                    {
                      command: "pnpm test",
                      exit_code: 0,
                      seconds: 1,
                      timeout_seconds: null,
                    },
                    {
                      command: "timeout 60 pnpm test",
                      exit_code: 1,
                      seconds: 2.5,
                      timeout_seconds: 60,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const file = readFileSync(html, "utf8");
    const pre = file.match(/<pre id="brief-json">([\s\S]*)<\/pre>/);
    expect(unescapeHtml(pre?.[1] ?? "")).toBe(JSON.stringify(parsed.result));
    const table = file.match(/<table id="tests-ctx-1">([\s\S]*?)<\/table>/);
    expect(table?.[1]?.match(/<tr>/g)).toHaveLength(2);
    expect(table?.[0]).toContain(
      "<td>pnpm test</td><td>0</td><td>1</td><td></td>",
    );
    expect(table?.[0]).toContain(
      "<td>timeout 60 pnpm test</td><td>1</td><td>2.5</td><td>60</td>",
    );
  });

  test("brief measures the pair, each Decision, and the escalations per Run, as JSON and as a table", async () => {
    const opened = new Date("2026-10-26T00:00:01.000Z");
    for (const [id, role, bytes, startedAt] of [
      ["ctx-dec", "decider", 812, "2026-10-26T00:00:03.500Z"],
      ["ctx-aud", "auditor", 640, "2026-10-26T00:00:05.000Z"],
    ] as const) {
      await conn.db.insertOperation({
        op_key: `op-${id}`,
        intent: "decide_seat",
        owner_generation: 1,
        at: opened,
      });
      await conn.db.insertDispatch({
        dispatch_id: id,
        task_id: null,
        decision_id: null,
        run_id: "run-1",
        seat: `${role}-seat`,
        role,
        requested_launch: {},
        effective_launch: null,
        model_attribution: "unknown",
        retry_of: null,
        op_key: `op-${id}`,
        settlement: "open",
        terminal_handle: null,
        created_at: new Date(startedAt),
        settled_at: null,
        activity: "waiting",
        manifest_id: null,
        prompt_bytes: bytes,
      });
    }
    await conn.sql`
      update ledger.run set coordinator_dispatch_id = 'ctx-dec' where run_id = 'run-1'`;
    await conn.db.insertManifest({
      id: "manifest-decision",
      run_id: "run-1",
      task_id: "task-1",
      decision_id: null,
      parent_id: null,
      references: [],
      tests: [],
      created_at: at,
    });
    await conn.sql`
      insert into ledger.decision
        (id, run_id, task_id, category, effect, question, options, manifest_id,
         state, reason, binding, budget, spent, created_at)
      values
        ('dec-1', 'run-1', 'task-1', 'plan', 'change_spec', 'Which plan?', '[]'::jsonb,
         'manifest-decision', 'needs_human', 'disagreement', 'run', '{}'::jsonb,
         '{}'::jsonb, ${at.toISOString()})`;
    const html = join(cwd, "measurement.html");
    const result = runBrief(cwd, ["brief", "story:S-1", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.result.stories[0].runs[0].measurement).toEqual({
      pair: {
        decider: {
          seat: "decider-seat",
          prompt_bytes: 812,
          cold_start_ms: 2500,
        },
        auditor: {
          seat: "auditor-seat",
          prompt_bytes: 640,
          cold_start_ms: 4000,
        },
      },
      decisions: [
        {
          decision_id: "dec-1",
          state: "needs_human",
          reason: "disagreement",
          effect: "change_spec",
          outcome: "open",
        },
      ],
      escalations: {
        "policy-required": 0,
        disagreement: 1,
        "context-missing": 0,
        "runtime-failure": 0,
        worker: 0,
        sample: 1,
        target: 10,
      },
    });
    const file = readFileSync(html, "utf8");
    const table = file.match(
      /<table id="measurement-run-1">([\s\S]*?)<\/table>/,
    );
    expect(table?.[0]).toContain(
      "<td>decider</td><td>decider-seat</td><td>812</td><td>2500</td>",
    );
    expect(table?.[0]).toContain(
      "<td>auditor</td><td>auditor-seat</td><td>640</td><td>4000</td>",
    );
    expect(table?.[0]).toContain(
      "<td>dec-1</td><td>needs_human</td><td>disagreement</td><td>change_spec</td><td>open</td>",
    );
    expect(table?.[0]).toContain(
      "<td>0</td><td>1</td><td>0</td><td>0</td><td>0</td><td>1/10</td>",
    );
  });

  test("an unknown story is story_not_found", () => {
    const result = runBrief(cwd, ["brief", "story:missing"]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "story_not_found", nextSteps: ["pod brief"] },
    });
  });
});

describe("waiting_on", () => {
  const hold = ["timeout", "cancel", "unknown"];
  const value = {
    summary: "plan, then build, then review",
    selector: { stage: "impl", size: ["xl"] },
    roles: ["planner", "developer", "reviewer"],
    steps: [
      { id: "plan", type: "worker", role: "planner", decision: "plan" },
      { id: "build", type: "worker", role: "developer", needs: ["plan"] },
      {
        id: "review",
        type: "worker",
        role: "reviewer",
        needs: ["build"],
        gate: "review",
      },
      {
        id: "both",
        type: "worker",
        role: "reviewer",
        needs: ["review"],
        gate: "review",
        decision: "plan",
      },
    ],
    edges: [
      { from: "plan", on: "agreed", to: "build" },
      { from: "plan", on: ["cancelled", ...hold], to: "hold" },
    ],
    limits: { attempts_per_task: 3, rework_per_lineage: 3 },
    escalation: { to: "operator" },
  };
  const revision = (body: unknown) => ({ value: body as Json });
  const process = revision(value);

  test.each([
    ["a ready decision step", process, "plan", "ready", "decision plan"],
    [
      "a delivered decision step",
      process,
      "plan",
      "delivered",
      "decision plan",
    ],
    ["a gated step", process, "review", "dispatched", "gate review"],
    ["a plain step", process, "build", "ready", null],
    ["a step with decision and gate", process, "both", "ready", null],
    ["a step id the process lacks", process, "gone", "ready", null],
    ["a passed decision step", process, "plan", "passed", null],
    ["a failed gated step", process, "review", "failed", null],
    ["a done gated step", process, "review", "done", null],
    ["a superseded gated step", process, "review", "superseded", null],
    [
      "a process that does not parse",
      revision({ steps: ["plan"] }),
      "plan",
      "ready",
      null,
    ],
    ["no process Revision", null, "plan", "ready", null],
  ] as const)("%s", (_name, rev, step_id, state, expected) => {
    expect(waitingOn(rev, { step_id, state })).toBe(expected);
  });
});
