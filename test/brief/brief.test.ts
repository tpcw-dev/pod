import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { snapshotHash } from "../../src/core/config/canonical-json.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Run, Story } from "../../src/core/domain/ledger.ts";
import { waitingOn } from "../../src/cli/brief.ts";
import { envelope, storeRevision } from "../db/fixtures.ts";
import { dbUrl, describeDb, openDb, podHome, resetDb } from "../db/helpers.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const at = new Date("2026-10-26T00:00:00.000Z");

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
): { status: number | null; stdout: string } {
  return spawnSync(
    join(repo, "node_modules/.bin/tsx"),
    [join(repo, "src/cli/index.ts"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, POD_DB_URL: dbUrl(), POD_HOME: podHome },
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
    };
    await conn.db.upsertStory(story);
    await conn.db.insertRun(run);
    const crew = envelope("crew", "crew", { seats: [] });
    const process = envelope("process", "flow", { steps: ["build"] });
    const policy = envelope("policy", "policy", { gates: ["review"] });
    const crewRow = await storeRevision(conn.db, crew);
    const processRow = await storeRevision(conn.db, process);
    const policyRow = await storeRevision(conn.db, policy);
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
    });
    mkdirSync(join(cwd, "specs/crew"), { recursive: true });
    mkdirSync(join(cwd, "specs/process"), { recursive: true });
    mkdirSync(join(cwd, "specs/policy"), { recursive: true });
    writeFileSync(join(cwd, "specs/crew/crew.yaml"), stringify(crew));
    writeFileSync(join(cwd, "specs/process/flow.yaml"), stringify(process));
    writeFileSync(
      join(cwd, "specs/policy/policy.yaml"),
      stringify(envelope("policy", "policy", { gates: ["other"] })),
    );
  });
  afterAll(() => conn.close());

  test("brief prints JSON, writes the same JSON as HTML, and marks drift", async () => {
    const [eventsBefore] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event`;
    const [opsBefore] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation`;
    const html = join(cwd, "brief.html");
    const result = runBrief(cwd, ["brief", "story:S-1", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      result: { stories: { stage: string; drift: { name: string }[] }[] };
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
    expect(parsed.result.stories[0]?.drift.map((item) => item.name)).toEqual([
      "policy",
    ]);
    const [eventsAfter] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.event`;
    const [opsAfter] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.operation`;
    expect(eventsAfter?.n).toBe(eventsBefore?.n);
    expect(opsAfter?.n).toBe(opsBefore?.n);
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
