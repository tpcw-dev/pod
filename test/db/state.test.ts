import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { StateScope, StateView } from "../../src/core/domain/state.ts";
import type {
  DocsPort,
  DocsReceipt,
  Section,
} from "../../src/core/ports/docs.ts";
import { buildState } from "../../src/core/state/view.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { gatedRun } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb, runCli } from "./helpers.ts";

const now = new Date("2026-10-31T12:00:00.000Z");
const sections = [
  "roadmap",
  "runs",
  "policies",
  "decisions",
  "usage",
  "needs_human",
  "learnings",
] as const;
const headings = [
  "Roadmap",
  "Active Runs",
  "Policies in force and Reserved categories",
  "Applicable decisions",
  "Usage coverage",
  "Open needs-human items",
  "Learnings",
];
const hqa = { pr: { keeper: "human-gatekeeper", type: "HQA" } };

function receipt(section: Section | null, error: string | null) {
  return {
    verb: "readSection",
    ok: section !== null,
    result: section,
    raw: null,
    error,
    requestId: null,
  } satisfies DocsReceipt<Section>;
}

function fakeDocs(pages: Record<string, Section | string>): DocsPort & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    readSection({ page, heading }) {
      reads.push(`${page} ${heading}`);
      const found = pages[heading];
      if (found === undefined)
        return Promise.resolve(receipt(null, "docs_section_not_found"));
      return Promise.resolve(
        typeof found === "string" ? receipt(null, found) : receipt(found, null),
      );
    },
  };
}

const roadmapPage = {
  "Current milestone": {
    heading: "Current milestone",
    paragraphs: ["M2 state view"],
    tables: [],
  },
  Milestones: {
    heading: "Milestones",
    paragraphs: [],
    tables: [
      {
        header: ["Milestone", "Status"],
        rows: [
          ["M1 core loop", "done"],
          ["M2 state view", "doing"],
          ["M3 decisions", "next"],
        ],
      },
    ],
  },
};

describeDb("pod state", () => {
  let conn: Connection;
  let projectPolicy: string;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(async () => {
    await gatedRun(conn, { gates: hqa });
    const revision = await storeRevision(
      conn.db,
      envelope("policy", "pod", {
        gates: hqa,
        roadmap: { provider: "notion", page: "page-1" },
        reserved: {
          deny: ["live_trading"],
          needs_human: ["spend", "credentials"],
          needs_existing_authorization: { repo_create: "story_spec" },
        },
      } as Json),
    );
    projectPolicy = revision.id;
    const activated = await conn.db.activate({
      scope: "project",
      scope_ref: "pod",
      kind: "policy",
      name: "pod",
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: now,
    });
    if (!activated.ok) throw new Error("project policy not activated");
  });
  afterAll(() => conn.close());

  async function state(
    scope: Partial<StateScope> = {},
    docs: DocsPort | null = null,
  ): Promise<StateView> {
    const built = await buildState(
      { repo: conn.db, docs, now: () => now },
      { story: null, project: null, ...scope },
    );
    if (!built.ok) throw new Error(built.refusal.message);
    return built.view;
  }

  async function processRevision(): Promise<string> {
    const snapshot = await conn.db.getSnapshot("run_1");
    return snapshot?.process_revision_id ?? "";
  }

  test("every section carries source_revision and observed_at", async () => {
    const view = await state({ project: "pod" }, fakeDocs(roadmapPage));
    for (const name of sections) {
      expect(view[name], name).toHaveProperty("source_revision");
      expect(view[name].observed_at, name).toBe(now.toISOString());
    }
    expect(view.roadmap.source_revision).toBe(projectPolicy);
    expect(view.policies.source_revision).toBe(projectPolicy);
    expect(view.runs.runs).toEqual([
      {
        run_id: "run_1",
        story: "S-1",
        state: "active",
        source_revision: await processRevision(),
        waiting_on: [
          "task_r gate pr keeper human-gatekeeper",
          "task_s needs task_r",
        ],
      },
    ]);
  });

  test("the roadmap reads both headings from the active policy's page and marks the current milestone", async () => {
    const docs = fakeDocs(roadmapPage);
    const view = await state({ project: "pod" }, docs);
    expect(docs.reads).toEqual([
      "page-1 Current milestone",
      "page-1 Milestones",
    ]);
    expect(view.roadmap).toMatchObject({
      status: "ok",
      page: "page-1",
      current: ["M2 state view"],
      milestones: [
        { text: "M1 core loop | done", current: false },
        { text: "M2 state view | doing", current: true },
        { text: "M3 decisions | next", current: false },
      ],
    });
  });

  test("no docs port is no_docs_port with a routing line, and a policy without roadmap is no_roadmap", async () => {
    const bare = await state({ project: "pod" });
    expect(bare.roadmap).toMatchObject({ status: "no_docs_port" });
    expect(bare.routing).toContain(
      "set the docs token or POD_DOCS_FIXTURES to read the roadmap",
    );
    const global = await state({}, fakeDocs(roadmapPage));
    expect(global.roadmap).toMatchObject({ status: "no_roadmap" });
    expect(global.routing).toContain(
      "set roadmap { provider, page } in the active policy",
    );
  });

  test("one failed heading makes the roadmap read_failed with that error and no milestones", async () => {
    const view = await state(
      { project: "pod" },
      fakeDocs({ ...roadmapPage, Milestones: "object_not_found" }),
    );
    expect(view.roadmap).toEqual({
      status: "read_failed",
      detail: "Milestones: object_not_found",
      source_revision: projectPolicy,
      observed_at: now.toISOString(),
    });
    expect(view.routing).toContain(
      "pod docs read --page page-1 --heading Milestones",
    );
  });

  test("--project falls back to the global policy and filters learnings, and Runs are not filtered by project", async () => {
    for (const [text, project] of [
      ["a pod learning", "pod"],
      ["a web learning", "web"],
    ] as const)
      await conn.db.insertLearning({
        source_story: "S-1",
        evidence_refs: ["e"],
        text,
        adoption: "adopted",
        area: "impl",
        project_id: project,
        created_at: now,
      });
    const web = await state({ project: "web" });
    expect(web.policies.policy?.name).toBe("default");
    expect(web.policies.policy?.id).not.toBe(projectPolicy);
    expect(web.learnings.learnings.map((row) => row.text)).toEqual([
      "a web learning",
    ]);
    expect(web.runs.runs.map((run) => run.run_id)).toEqual(["run_1"]);
    const pod = await state({ project: "pod" });
    expect(pod.policies).toMatchObject({
      policy: { id: projectPolicy, name: "pod" },
      crew: { name: "default" },
      reserved: {
        deny: ["live_trading"],
        needs_human: ["spend", "credentials"],
        needs_existing_authorization: ["repo_create: story_spec"],
      },
    });
  });

  test("usage with no source is unknown with no_source, and a measured value keeps its number", async () => {
    await conn.sql`truncate ledger.usage_observation`;
    expect((await state()).usage.providers).toEqual([
      {
        provider: "claude",
        value: "unknown",
        coverage: "no_source",
        observed_at: null,
      },
      {
        provider: "codex",
        value: "unknown",
        coverage: "no_source",
        observed_at: null,
      },
    ]);
    await conn.db.insertUsageObservation({
      provider: "claude",
      seat: null,
      window_start: now,
      window_end: now,
      value: "12.5",
      coverage: "measured",
      observed_at: new Date(now.getTime() - 60_000),
      source: { kind: "none" },
    });
    let view = await state();
    expect(view.usage.providers).toEqual([
      {
        provider: "claude",
        value: "12.5",
        coverage: "measured",
        observed_at: new Date(now.getTime() - 60_000).toISOString(),
      },
      {
        provider: "codex",
        value: "unknown",
        coverage: "no_source",
        observed_at: null,
      },
    ]);
    await conn.db.insertUsageObservation({
      provider: "claude",
      seat: null,
      window_start: now,
      window_end: now,
      value: null,
      coverage: "no_source",
      observed_at: now,
      source: { kind: "none" },
    });
    view = await state();
    expect(view.usage.providers[0]).toEqual({
      provider: "claude",
      value: "unknown",
      coverage: "no_source",
      observed_at: now.toISOString(),
    });
  });

  test("needs-human lists the delivered HQA Task with its gate, keeper, and Story", async () => {
    const view = await state();
    expect(view.needs_human.items).toEqual([
      {
        story: "S-1",
        run_id: "run_1",
        task_id: "task_r",
        gate: "pr",
        keeper: "human-gatekeeper",
        open: true,
        reason: "awaiting pr PASS or FAIL from human-gatekeeper",
        at: expect.any(String),
      },
    ]);
  });

  test("a held Run is listed, and a held Task names its hold reason or plain hold", async () => {
    await conn.db.setRunState("run_1", "hold");
    await conn.db.setTaskState("task_s", "hold");
    let view = await state();
    expect(view.runs.runs[0]).toMatchObject({
      state: "hold",
      waiting_on: ["task_r gate pr keeper human-gatekeeper", "task_s hold"],
    });
    await conn.db.appendEvent({
      type: "hold",
      ts: now,
      host: "local",
      run_id: "run_1",
      task_id: "task_s",
      dispatch_id: null,
      op_key: null,
      payload: { reason: "cancel", from: "pending" },
      source: { kind: "command" },
    });
    view = await state();
    expect(view.runs.runs[0]?.waiting_on).toContain("task_s hold cancel");
    await conn.db.setRunState("run_1", "done");
    expect((await state()).runs.runs).toEqual([]);
  });

  test("story:<id> limits Runs to that Story, and an unknown Story is story_not_found", async () => {
    expect((await state({ story: "S-1" })).runs.runs).toHaveLength(1);
    expect(
      await buildState(
        { repo: conn.db, docs: null, now: () => now },
        { story: "S-2", project: null },
      ),
    ).toMatchObject({ ok: false, refusal: { code: "story_not_found" } });
  });

  test("the CLI prints the seven sections, exits 3 only for an unknown Story, and writes the HTML", () => {
    expect(runCli(["state", "--help"]).status).toBe(0);
    const printed = runCli(["state", "--json"]);
    expect(printed.status).toBe(0);
    expect(Object.keys(printed.json.result ?? {})).toEqual(
      expect.arrayContaining([...sections]),
    );
    expect(printed.json.result?.["roadmap"]).toMatchObject({
      status: "no_docs_port",
    });
    expect(printed.json.result?.["routing"]).toContain(
      "set the docs token or POD_DOCS_FIXTURES to read the roadmap",
    );
    expect(runCli(["state", "--project", "nowhere", "--json"]).status).toBe(0);
    const unknown = runCli(["state", "story:NOPE", "--json"]);
    expect(unknown.status).toBe(3);
    expect(unknown.json.error?.code).toBe("story_not_found");
    const out = join(mkdtempSync(join(tmpdir(), "pod-state-")), "out.html");
    expect(runCli(["state", "--html", out, "--json"]).status).toBe(0);
    const html = readFileSync(out, "utf8");
    for (const heading of headings) expect(html).toContain(heading);
    const missing = join(tmpdir(), "no-such-dir-pod-state", "out.html");
    expect(runCli(["state", "--html", missing, "--json"]).status).toBe(1);
  });
});
