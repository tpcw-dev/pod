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
import { decideDigest } from "../../src/core/digest/decide.ts";
import { postDigest } from "../../src/core/digest/post.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Run, Story } from "../../src/core/domain/ledger.ts";
import { addLearning } from "../../src/core/learning/add.ts";
import { publishPlan } from "../../src/core/plan/plan.ts";
import { writeOverride } from "../../src/core/plan/write.ts";
import { waitingOn } from "../../src/core/process/waiting.ts";
import { fakeTracker, listedStory } from "../db/fake-tracker.ts";
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
      rate_revision_id: null,
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
    await conn.db.insertOperation({
      op_key: "usage:ctx-dec",
      intent: "usage",
      owner_generation: 1,
      at: opened,
    });
    await conn.db.insertUsageRecord({
      runtime: "example-runtime",
      session_id: "s-ctx-dec",
      model: "example-model",
      input: 1000,
      cached_input: 200,
      cache_write: 100,
      output: 50,
      reasoning: 10,
      calls: 1,
      first_at: opened,
      through: opened,
      dispatch_id: "ctx-dec",
      run_id: null,
      attribution: "locator",
      coverage: "measured",
      op_key: "usage:ctx-dec",
      created_at: opened,
    });
    const html = join(cwd, "measurement.html");
    const result = runBrief(cwd, ["brief", "story:S-1", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const { usage, ...measurement } =
      parsed.result.stories[0].runs[0].measurement;
    expect(usage).toEqual({
      tokens: {
        input: null,
        cached_input: null,
        cache_write: null,
        output: null,
        reasoning: null,
      },
      running_minutes: null,
      wall_minutes: null,
      cost: {
        basis: "list-price equivalent",
        amount: null,
        currency: null,
        reason: "unmeasured",
      },
      unknown: {
        tokens: ["ctx-1", "ctx-aud"],
        minutes: ["ctx-1", "ctx-aud", "ctx-dec"],
      },
    });
    expect(measurement).toEqual({
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

  test("brief carries today's usage section as JSON and as the usage table", async () => {
    const now = new Date();
    await conn.db.insertOperation({
      op_key: "usage:brief-loose",
      intent: "usage",
      owner_generation: 1,
      at: now,
    });
    await conn.db.insertUsageRecord({
      runtime: "example-runtime",
      session_id: "s-brief-loose",
      model: null,
      input: 400,
      cached_input: 0,
      cache_write: 0,
      output: 100,
      reasoning: 0,
      calls: 1,
      first_at: now,
      through: now,
      dispatch_id: null,
      run_id: null,
      attribution: "unattributed",
      coverage: "measured",
      op_key: "usage:brief-loose",
      created_at: now,
    });
    const html = join(cwd, "usage.html");
    const result = runBrief(cwd, ["brief", "--html", html]);
    expect(result.status).toBe(0);
    const { usage } = JSON.parse(result.stdout).result;
    expect(usage).toMatchObject({
      day: now.toISOString().slice(0, 10),
      time_zone: "UTC",
      unattributed: [
        {
          runtime: "example-runtime",
          records: 1,
          tokens: {
            input: 400,
            cached_input: 0,
            cache_write: 0,
            output: 100,
            reasoning: 0,
          },
          cost: { amount: null, reason: "unpriced" },
        },
      ],
      coverage: { tokens_source: { unattributed: 1 } },
    });
    const table = readFileSync(html, "utf8").match(
      /<table id="usage">([\s\S]*?)<\/table>/,
    );
    expect(table?.[0]).toContain(
      "<td>overall</td><td>0</td><td>0</td><td>0</td><td>0.0000</td><td>0</td><td>unknown</td><td>unknown</td>",
    );
    expect(table?.[0]).toContain(
      "<td>unattributed example-runtime</td><td>500</td><td></td><td></td><td>unknown (unpriced)</td>",
    );
  });

  test("brief carries yesterday's log as JSON and as the yesterday table", async () => {
    const now = new Date();
    const noon = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12),
    );
    await conn.db.appendEvent({
      type: "escalate",
      ts: noon,
      host: "local",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { story: "S-yesterday", kind: "p0", text: "a<b" },
      source: { kind: "command", verb: "test" },
    });
    const html = join(cwd, "yesterday.html");
    const result = runBrief(cwd, ["brief", "--html", html]);
    expect(result.status).toBe(0);
    const { yesterday } = JSON.parse(result.stdout).result;
    expect(yesterday).toMatchObject({
      host: "local",
      day: noon.toISOString().slice(0, 10),
      time_zone: "UTC",
    });
    expect(
      yesterday.headings.map((group: { heading: string }) => group.heading),
    ).toEqual([
      "Launched",
      "Closed",
      "Groomed",
      "Decided",
      "Needs a person",
      "Held",
      "Skipped",
      "Errors",
    ]);
    expect(yesterday.headings[4].lines).toMatchObject([
      { type: "escalate", text: "escalate story=S-yesterday kind=p0 text=a<b" },
    ]);
    const table = readFileSync(html, "utf8").match(
      /<table id="yesterday">([\s\S]*?)<\/table>/,
    );
    expect(table?.[0]).toContain(
      "<td>Needs a person</td><td>escalate story=S-yesterday kind=p0 text=a&lt;b</td>",
    );
    expect(table?.[0]).toContain("<td>Groomed</td><td>none</td>");
  });

  test("an unknown story is story_not_found", () => {
    const result = runBrief(cwd, ["brief", "story:missing"]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "story_not_found", nextSteps: ["pod brief"] },
    });
  });

  test("each project row carries the digest section, and the HTML adds its line and proposal list", async () => {
    const now = () => new Date();
    const ids: number[] = [];
    for (const text of ["one", "two", "three", "four"]) {
      const added = await addLearning(conn.db, {
        row: {
          source_story: "S-1",
          evidence_refs: [`pr:${text}`],
          text,
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
      ids.push(added.id);
    }
    const posted = await postDigest(conn.db, {
      project: null,
      proposals: ids.map((id, n) => ({
        theme: `t${n}`,
        text: `a<b ${n}`,
        learning_ids: [id],
        evidence_refs: [`pr:${n}`],
      })),
      host: "local",
      now,
    });
    if (!posted.ok) throw new Error(posted.refusal.message);
    const [first] = posted.shown;
    await decideDigest(conn.db, {
      number: first?.number ?? 0,
      verdict: "accept",
      reason: "ok",
      actor: "person:human",
      host: "local",
      now,
    });
    const html = join(cwd, "digest.html");
    const result = runBrief(cwd, ["brief", "--html", html]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      result: { projects: { project: string; digest: Json }[] };
    };
    const global = parsed.result.projects.find(
      (row) => row.project === "global",
    );
    expect(global?.digest).toEqual({
      cap: 3,
      shown: 3,
      queued: 1,
      open: 2,
      queue: 1,
      proposals: posted.shown.map((row, n) => ({
        number: row.number,
        theme: `t${n}`,
        text: `a<b ${n}`,
        evidence_refs: [`pr:${n}`],
        ruling: n === 0 ? "accept" : "open",
      })),
    });
    const file = readFileSync(html, "utf8");
    expect(file).toContain('<p id="digest-global">Digest 3/3, 1 queued</p>');
    expect(file).toContain('<table id="digest-proposals-global">');
    expect(file).toContain("<td>a&lt;b 1</td>");
  });

  test("--project keeps only that project's runs and project row", async () => {
    await conn.db.upsertStory({
      provider: "tracker",
      external_id: "S-app",
      size: "s",
      stage: "impl",
      run_id: "run-app",
      dependencies: [],
      synced_at: at,
      status: null,
      title: null,
      kickoff_line: null,
    });
    await conn.db.insertRun({
      run_id: "run-app",
      story_provider: "tracker",
      story_external_id: "S-app",
      host: "local",
      coordinator: "session-app",
      owner_generation: 1,
      snapshot_hash: "pending",
      state: "active",
      created_at: at,
      coordinator_dispatch_id: null,
    });
    const [base] = await conn.sql<
      {
        crew_revision_id: string;
        process_revision_id: string;
        policy_revision_id: string;
      }[]
    >`select crew_revision_id, process_revision_id, policy_revision_id
      from config.snapshot where run_id = 'run-1'`;
    if (base === undefined) throw new Error("no run-1 snapshot");
    await conn.db.insertSnapshot({
      run_id: "run-app",
      crew_revision_id: base.crew_revision_id,
      process_revision_id: base.process_revision_id,
      policy_revision_id: base.policy_revision_id,
      rate_revision_id: null,
      effective_gate_map: {},
      hash: "hash-app",
      pinned_at: at,
      project: "app",
      profile: null,
    });
    const all = JSON.parse(runBrief(cwd, ["brief"]).stdout) as {
      result: { stories: { external_id: string }[] };
    };
    expect(all.result.stories.map((row) => row.external_id).sort()).toEqual([
      "S-1",
      "S-app",
    ]);
    const result = runBrief(cwd, ["brief", "--project", "app"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      result: {
        stories: { external_id: string; runs: { run_id: string }[] }[];
        projects: { project: string }[];
      };
    };
    expect(parsed.result.stories).toMatchObject([
      { external_id: "S-app", runs: [{ run_id: "run-app" }] },
    ]);
    expect(parsed.result.projects.map((row) => row.project)).toEqual(["app"]);

    await conn.db.insertRun({
      run_id: "run-1-app",
      story_provider: "tracker",
      story_external_id: "S-1",
      host: "local",
      coordinator: "session-1-app",
      owner_generation: 1,
      snapshot_hash: "pending",
      state: "active",
      created_at: at,
      coordinator_dispatch_id: null,
    });
    await conn.db.insertSnapshot({
      run_id: "run-1-app",
      crew_revision_id: base.crew_revision_id,
      process_revision_id: base.process_revision_id,
      policy_revision_id: base.policy_revision_id,
      rate_revision_id: null,
      effective_gate_map: {},
      hash: "hash-1-app",
      pinned_at: at,
      project: "app",
      profile: null,
    });
    const split = JSON.parse(
      runBrief(cwd, ["brief", "story:S-1", "--project", "app"]).stdout,
    ) as {
      result: {
        stories: {
          run_id: string | null;
          counters: unknown;
          runs: { run_id: string; counters: unknown }[];
        }[];
      };
    };
    const [kept] = split.result.stories;
    expect(kept?.runs.map((run) => run.run_id)).toEqual(["run-1-app"]);
    expect(kept?.run_id).toBeNull();
    expect(kept?.counters).toEqual(kept?.runs[0]?.counters);
  });

  test("brief carries each host's day plan as JSON and as the plan table", async () => {
    const now = new Date();
    async function active(
      row: Awaited<ReturnType<typeof storeRevision>>,
      scope: "global" | "host" | "project",
      scopeRef: string,
    ) {
      const activated = await conn.db.activate({
        scope,
        scope_ref: scopeRef,
        kind: row.kind,
        name: row.name,
        expected: null,
        revision_id: row.id,
        bundle_id: null,
        activated_by: "operator",
        activated_at: at,
      });
      if (!activated.ok) throw new Error(`${row.kind} not activated`);
    }
    const host = {
      driver: "driver-a",
      manager: false,
      slots: { default: 1, max: 3 },
      reserved: {},
    };
    await active(
      await storeRevision(conn.db, {
        ...envelope("host", "local", {
          ...host,
          hostnames: ["host-a"],
          timezone: "Africa/Abidjan",
          projects: ["planned"],
        }),
        scope: "host",
        scope_ref: "local",
      }),
      "host",
      "local",
    );
    await active(
      await storeRevision(conn.db, {
        ...envelope("host", "bare", {
          ...host,
          hostnames: ["host-b"],
          projects: [],
        }),
        scope: "host",
        scope_ref: "bare",
      }),
      "host",
      "bare",
    );
    await active(
      await storeRevision(
        conn.db,
        envelope("project", "planned", {
          repo: "tpcw-dev/planned",
          category: "Meta",
          staging: false,
          tracker: { project_name: "planned", project_id: "id-planned" },
        }),
      ),
      "global",
      "",
    );
    await active(
      await storeRevision(conn.db, {
        ...envelope("crew", "crew", {
          seats: [{ id: "dev-p", roles: ["developer"], runtime: "claude" }],
        }),
        scope: "project",
        scope_ref: "planned",
      }),
      "project",
      "planned",
    );
    await active(
      await storeRevision(
        conn.db,
        envelope("process", "impl", {
          selector: { stage: "impl", size: ["s"] },
        }),
      ),
      "global",
      "",
    );
    const write = (request: Parameters<typeof writeOverride>[1]["request"]) =>
      writeOverride(conn.db, {
        host: "local",
        writer: "local",
        actor: "person:human",
        now,
        request,
      });
    const day = now.toISOString().slice(0, 10);
    expect(
      await write({ kind: "stretch", slots: 2, reason: "launch" }),
    ).toMatchObject({ ok: true });
    expect(
      await write({ kind: "hold", key: "P-9", reason: "waits", until: null }),
    ).toMatchObject({ ok: true });
    expect(
      await write({ kind: "reset_available", harness: "claude", until: day }),
    ).toMatchObject({ ok: true });
    const tracker = fakeTracker();
    tracker.listings = {
      "id-planned": ["P-1", "P-2", "P-3"].map((key, index) =>
        listedStory({
          ref: { provider: "linear", external_id: key },
          title: key,
          priority: index + 1,
        }),
      ),
    };
    expect(
      await publishPlan(conn.db, {
        host: "local",
        writer: "local",
        actor: "person:human",
        now,
        sources: { tracker, docs: null },
      }),
    ).toMatchObject({
      ok: true,
      ranked: [{ key: "P-1" }, { key: "P-2" }, { key: "P-3" }],
    });
    const html = join(cwd, "plan.html");
    const result = runBrief(cwd, ["brief", "--html", html]);
    expect(result.status).toBe(0);
    const { plan } = JSON.parse(result.stdout).result;
    expect(plan).toMatchObject({
      hosts: [
        {
          host: "local",
          day,
          capacity: {
            slots_default: 1,
            slots_max: 3,
            slots: 2,
            stretch: { slots: 2, reason: "launch" },
          },
          ranked: [{ key: "P-1" }, { key: "P-2" }],
          ranked_total: 3,
          held: [{ key: "P-9", reason: "waits" }],
          usage: [{ provider: "claude", state: "reset" }],
          overrides: { holds: [{ key: "P-9" }], priority: null, order: null },
          resets: [{ harness: "claude", until: day }],
        },
      ],
      refused: [{ host: "bare", code: "config_missing" }],
    });
    const table = readFileSync(html, "utf8").match(
      /<table id="plan">([\s\S]*?)<\/table>/,
    );
    expect(table?.[0]).toContain(
      `<td>local</td><td>${day}</td><td>2 (stretched from 1: launch)</td><td>P-1 P-2 of 3</td><td>P-9: waits</td><td>claude reset</td><td>hold P-9; reset claude until ${day}</td>`,
    );
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
