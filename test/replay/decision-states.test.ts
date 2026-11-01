import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { supersedeOpKey } from "../../src/core/process/project.ts";
import { buildState } from "../../src/core/state/view.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import {
  applyConfig,
  audit,
  auditor,
  cliDeliveredPlan,
  cliReplay,
  decideArgs,
  decider,
  delivery,
  evidence,
  generation,
  implementTask,
  opensAuditor,
  opensDecider,
  planTask,
  proposal,
  questionFile,
  refusedReply,
  run,
  seatTask,
  sent,
  taskSpec,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb } from "../db/helpers.ts";
import { empty, workers } from "../db/run-fixture.ts";

const dir = "test/replay/decision-states";
const processRef = "decision-states@1";
const keeper = "keeper-1";

interface Row {
  name: string;
  row: number;
  from: string;
  event: string;
  to: string;
  drive: () => Promise<void>;
}

const rollout = {
  question: "Which rollout should the plan use?",
  options: ["one release", "two releases with a rollback step"],
};

function specFile(spec: string): string {
  return questionFile({
    question: "Replace the plan spec?",
    options: ["replace it", "keep it"],
    spec: { kind: "task", schema_version: 1, spec },
  });
}

function trackerStory(story: string): string {
  return JSON.stringify({
    data: {
      issue: {
        id: "00000000-0000-4000-8000-000000000001",
        identifier: story,
        title: "decision-states replay Story",
        description: "A Story the decision-states replay scenarios read.",
        estimate: null,
        state: {
          id: "00000000-0000-4000-8000-000000000002",
          name: "Doing",
          type: "started",
        },
        labels: { nodes: [] },
        team: {
          id: "00000000-0000-4000-8000-000000000003",
          key: "trk",
          states: {
            nodes: [
              {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Doing",
                type: "started",
              },
            ],
          },
        },
      },
    },
  });
}

interface Comment {
  id: string;
  body: string;
}

function trackerEntry(
  method: string,
  operation: string,
  variables: Record<string, unknown>,
  body: string,
) {
  return {
    method,
    match: { operation, variables },
    status: 200,
    body,
    error: null,
    recordedAt: "2026-11-01T00:00:00.000Z",
  };
}

function rulingTracker(story: string, comments: readonly Comment[]): string {
  const nodes = comments.map((row) => ({
    id: row.id,
    body: row.body,
    editedAt: null,
    user: { id: keeper },
  }));
  const [newest] = comments;
  const entries = [
    trackerEntry("readStory", "Story", { id: story }, trackerStory(story)),
    trackerEntry("readback", "Story", { id: story }, trackerStory(story)),
    trackerEntry(
      "readback",
      "StoryComments",
      { id: story, after: null },
      JSON.stringify({
        data: {
          issue: {
            comments: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: newest?.id ?? null },
            },
          },
        },
      }),
    ),
    ...nodes.map((node) =>
      trackerEntry(
        "readComment",
        "Comment",
        { id: node.id },
        JSON.stringify({
          data: { comment: { ...node, issue: { identifier: story } } },
        }),
      ),
    ),
  ];
  const out = mkdtempSync(join(tmpdir(), "pod-tracker-"));
  for (const [i, entry] of entries.entries())
    writeFileSync(
      join(out, `${String(i + 1).padStart(3, "0")}-${entry.method}.json`),
      JSON.stringify(entry),
    );
  return out;
}

function keeperHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pod-keeper-home-"));
  writeFileSync(
    join(home, "bypass.jsonl"),
    `${JSON.stringify({ host: hostname(), result: "pass", at: "2026-11-01T00:00:00.000Z" })}\n`,
  );
  return home;
}

function specTable(): string[][] {
  const lines = readFileSync("docs/tech-spec.md", "utf8").split("\n");
  const head = lines.indexOf("| From | Event | To |");
  const body: string[][] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith("|")) break;
    body.push(
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
  }
  return body;
}

describeDb("decision states", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig([
      `${dir}/policy.yaml`,
      `${dir}/crew.yaml`,
      `${dir}/process.yaml`,
      "specs/decision/default.yaml",
    ]);
  });
  afterAll(() => conn.close());

  const story = (row: number) => `TRK-${row}`;

  async function plan(row: number): Promise<void> {
    await cliDeliveredPlan(conn, story(row), processRef);
  }

  async function decide(
    file: string,
    orca: readonly TempEntry[] = opensDecider,
    effect = "accept_plan",
    more: string[] = [],
  ) {
    return cliReplay(conn, decideArgs(file, effect, more), orca);
  }

  async function opened(row: number): Promise<string> {
    await plan(row);
    const result = await decide(questionFile(rollout));
    expect(result.status, result.json.error?.message).toBe(0);
    expect(result.json.result).toMatchObject({ state: "round:1" });
    return String(result.json.result?.["decision_id"]);
  }

  async function pass(
    orca: readonly TempEntry[],
    env: Record<string, string> = {},
  ) {
    const result = await cliReplay(
      conn,
      ["check", ...run, ...generation],
      orca,
      env,
    );
    expect(result.status, result.json.error?.message).toBe(0);
    return result.json.result ?? {};
  }

  async function proposed(id: string): Promise<void> {
    await pass(delivery("delivery_p1", [proposal("p1", id, 1)], opensAuditor));
  }

  async function decision(id: string) {
    const row = await conn.db.getDecision(id);
    if (row === null) throw new Error(`no Decision ${id}`);
    return row;
  }

  async function decisionEvents(id: string) {
    return conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event
      where type = 'decision' and payload->>'decision_id' = ${id} order by id`;
  }

  async function rounds(id: string) {
    return conn.sql<{ round: number; stance: string; manifest_id: string }[]>`
      select round, stance, manifest_id from ledger.decision_round
      where decision_id = ${id} order by round`;
  }

  async function view(row: number) {
    const built = await buildState(
      { repo: conn.db, docs: null, now: () => new Date() },
      { story: story(row), project: null },
    );
    if (!built.ok) throw new Error(built.refusal.message);
    return built.view;
  }

  async function settledAs(
    row: number,
    id: string,
    state: string,
    reason: string,
  ): Promise<void> {
    expect(await decision(id)).toMatchObject({
      state,
      reason,
      closed_at: expect.any(Date),
    });
    expect((await view(row)).decisions.decisions).toContainEqual(
      expect.objectContaining({ id }),
    );
  }

  async function taskState(task: string) {
    return (await conn.db.getTask(task))?.state;
  }

  async function seats(): Promise<number> {
    const [row] = await conn.sql<{ n: number }[]>`
      select count(*)::int as n from ledger.dispatch where decision_id is not null`;
    return row?.n ?? 0;
  }

  async function onlyDecision(): Promise<string> {
    const [row] = await conn.sql<
      { id: string }[]
    >`select id from ledger.decision`;
    return row?.id ?? "";
  }

  const failsDecider = [
    seatTask("decider"),
    refusedReply("worker-start", "failed", ["--task", "orca_decider"]),
    seatTask("decider"),
    refusedReply("worker-start", "failed", ["--task", "orca_decider"]),
  ];

  async function failedAtOpen(row: number): Promise<string> {
    await plan(row);
    const failed = await decide(questionFile(rollout), failsDecider);
    expect(failed.status).not.toBe(0);
    const id = await onlyDecision();
    expect(await decision(id)).toMatchObject({
      state: "needs_human",
      reason: "runtime-failure",
      outcome: expect.objectContaining({ round: 1 }),
    });
    return id;
  }

  async function resumeSpent(id: string) {
    return (await decision(id)).spent as Record<string, number>;
  }

  let failed = "";

  const rows: Row[] = [
    {
      name: "row 1: `requested` | Reserved deny hit",
      row: 1,
      from: "`requested`",
      event: "Reserved deny hit",
      to: "`reserved_denied`, a Decision event is recorded, with no loop and no wait for the human",
      drive: async () => {
        await plan(1);
        const denied = await decide(
          questionFile({
            ...rollout,
            question: "Should the worker shred the archive?",
          }),
          [],
        );
        expect(denied.status).not.toBe(0);
        expect(denied.json.error?.code).toBe("decision_denied");
        const id = await onlyDecision();
        await settledAs(1, id, "reserved_denied", "denied");
        expect(
          (await decisionEvents(id)).map((row) => row.payload),
        ).toMatchObject([
          {
            outcome: "reserved_denied",
            reserved: { class: "deny", member: "archive_shred" },
          },
        ]);
        expect([await seats(), (await rounds(id)).length]).toEqual([0, 0]);
      },
    },
    {
      name: "row 2: `requested` | Reserved needs_human hit",
      row: 2,
      from: "`requested`",
      event: "Reserved needs_human hit",
      to: "`reserved_needs_human`, then `needs_human` with reason `policy-required`, with no rounds spent",
      drive: async () => {
        await plan(2);
        const held = await decide(
          questionFile({
            ...rollout,
            question: "Should the plan call the vendor first?",
          }),
          [],
        );
        expect(held.status, held.json.error?.message).toBe(0);
        expect(held.json.result).toMatchObject({
          state: "needs_human",
          round: 0,
          reserved: { class: "needs_human", member: "vendor_call" },
        });
        const id = String(held.json.result?.["decision_id"]);
        await settledAs(2, id, "needs_human", "policy-required");
        expect(
          (await decisionEvents(id)).map((row) => row.payload["outcome"]),
        ).toEqual(["reserved_needs_human", "needs_human"]);
        expect([await seats(), (await rounds(id)).length]).toEqual([0, 0]);
      },
    },
    {
      name: "row 3: `requested` | Reserved needs_existing_authorization hit, and the Story or an infrastructure Story authorizes it",
      row: 3,
      from: "`requested`",
      event:
        "Reserved needs_existing_authorization hit, and the Story or an infrastructure Story authorizes it",
      to: "`round(1)`",
      drive: async () => {
        await plan(3);
        const opened = await decide(
          questionFile({
            ...rollout,
            question: "Should the plan open a mirror?",
          }),
        );
        expect(opened.status, opened.json.error?.message).toBe(0);
        expect(opened.json.result).toMatchObject({
          state: "round:1",
          decider_dispatch_id: decider,
          reserved: null,
        });
        expect(
          (await decision(String(opened.json.result?.["decision_id"]))).state,
        ).toBe("round:1");
      },
    },
    {
      name: "row 4: `requested` | Reserved needs_existing_authorization hit, and nothing authorizes it",
      row: 4,
      from: "`requested`",
      event:
        "Reserved needs_existing_authorization hit, and nothing authorizes it",
      to: "`needs_human` with reason `policy-required`",
      drive: async () => {
        await plan(4);
        const held = await decide(
          questionFile({
            ...rollout,
            question: "Should the plan open a mirror?",
          }),
          [],
        );
        expect(held.status, held.json.error?.message).toBe(0);
        expect(held.json.result).toMatchObject({
          state: "needs_human",
          reserved: {
            class: "needs_existing_authorization",
            member: "mirror_open",
          },
        });
        const id = String(held.json.result?.["decision_id"]);
        await settledAs(4, id, "needs_human", "policy-required");
        expect(await seats()).toBe(0);
      },
    },
    {
      name: "row 5: `requested` | no Reserved hit",
      row: 5,
      from: "`requested`",
      event: "no Reserved hit",
      to: "`round(1)`",
      drive: async () => {
        const id = await opened(5);
        expect(await decision(id)).toMatchObject({
          state: "round:1",
          closed_at: null,
        });
        expect(await decisionEvents(id)).toEqual([]);
      },
    },
    {
      name: "row 6: `round(n)` | both agree",
      row: 6,
      from: "`round(n)`",
      event: "both agree",
      to: 'dependencies re-checked, then `agreed`, and the outcome applies by its `effect` as "Decision effects" describes',
      drive: async () => {
        const id = await opened(6);
        await proposed(id);
        await pass(delivery("delivery_a1", [audit("a1", id, 1, "agree")]));
        await settledAs(6, id, "agreed", "agreed");
        const [decided] = await decisionEvents(id);
        expect(decided?.payload).toMatchObject({
          outcome: "agreed",
          effect: "accept_plan",
          rounds: 1,
          manifest_id: (await decision(id)).manifest_id,
        });
        expect(await taskState(planTask)).toBe("done");
        expect(await taskState(implementTask)).toBe("ready");
      },
    },
    {
      name: "row 7: `round(n)` or `awaiting_evidence(n)` | the pair proposes a plan change on an `accept_plan` Decision",
      row: 7,
      from: "`round(n)` or `awaiting_evidence(n)`",
      event: "the pair proposes a plan change on an `accept_plan` Decision",
      to: "`superseded`, with `by` the new `change_spec` Decision the coordinator opens, and no rounds spent on the old Decision after that",
      drive: async () => {
        const old = await opened(7);
        await proposed(old);
        const superseding = await decide(
          specFile("Plan it in two releases."),
          [sent(decider)],
          "change_spec",
          ["--supersedes", old],
        );
        expect(superseding.status, superseding.json.error?.message).toBe(0);
        const id = String(superseding.json.result?.["decision_id"]);
        await settledAs(7, old, "superseded", "superseded");
        expect((await decision(old)).outcome).toMatchObject({ by: id });
        expect(await decision(id)).toMatchObject({
          state: "round:1",
          effect: "change_spec",
          supersedes_decision_id: old,
        });
        const late = await pass(
          delivery("delivery_a1", [audit("a1", old, 1, "agree")]),
        );
        expect(late["ignored"]).toBe(1);
        expect(await rounds(old)).toEqual([]);
      },
    },
    {
      name: "row 8: `round(n)` | both agree, but a dependency's source Revision changed",
      row: 8,
      from: "`round(n)`",
      event: "both agree, but a dependency's source Revision changed",
      to: "`needs_human` with reason `context-missing`, and the outcome is not executable",
      drive: async () => {
        const id = await opened(8);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "disagree")],
            [sent(decider)],
          ),
        );
        const pinned = await conn.db.getRevisionByRef(
          "process",
          "decision-states",
          1,
        );
        const revised = join(
          mkdtempSync(join(tmpdir(), "pod-process-")),
          "p.yaml",
        );
        writeFileSync(
          revised,
          readFileSync(`${dir}/process.yaml`, "utf8").replace(
            "summary: decision-states replay scenarios",
            "summary: decision-states replay scenarios, revised",
          ),
        );
        const applied = await cliReplay(conn, [
          "config",
          "apply",
          revised,
          "--activate",
          "--scope",
          "global",
          "--expected-revision",
          pinned?.id ?? "none",
        ]);
        expect(applied.status, applied.json.error?.message).toBe(0);
        expect((await conn.db.getSnapshot("run_1"))?.process_revision_id).toBe(
          pinned?.id,
        );
        await pass(
          delivery("delivery_p2", [proposal("p2", id, 2)], [sent(auditor)]),
        );
        expect((await decision(id)).state).toBe("round:2");
        const {
          revision: { id: spec },
        } = await conn.db.insertRevision(
          taskSpec(
            { lineage_id: "run_1:plan", run_id: "run_1" },
            "Plan it per the revised process.",
          ),
        );
        await conn.sql`update ledger.task set spec_revision_id = ${spec}
          where task_id = ${planTask}`;
        await pass(delivery("delivery_a2", [audit("a2", id, 2, "agree")]));
        await settledAs(8, id, "needs_human", "context-missing");
        expect((await decisionEvents(id)).at(-1)?.payload).toMatchObject({
          outcome: "needs_human",
          reason: "context-missing",
          changed: expect.stringMatching(/^task:/),
        });
        expect(await taskState(planTask)).toBe("delivered");
        expect(await taskState(implementTask)).toBe("pending");
        expect(await conn.db.getOperation(supersedeOpKey(id))).toBeNull();
      },
    },
    {
      name: "row 9: `round(n)` | one side escalates",
      row: 9,
      from: "`round(n)`",
      event: "one side escalates",
      to: "affected actions stop first, the other side evaluates, and continued disagreement counts as a round",
      drive: async () => {
        const id = await opened(9);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "escalate")],
            [sent(decider)],
          ),
        );
        expect((await decision(id)).state).toBe("round:2");
        expect(await rounds(id)).toMatchObject([
          { round: 1, stance: "escalate" },
        ]);
        expect((await conn.db.getDispatch(decider))?.activity).toBe("running");
      },
    },
    {
      name: "row 10: `round(n)` | auditor answers needs_evidence",
      row: 10,
      from: "`round(n)`",
      event: "auditor answers needs_evidence",
      to: "`awaiting_evidence(n)`, which is not a round and counts against `tool_calls`",
      drive: async () => {
        const id = await opened(10);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "needs_evidence")],
            [sent(decider)],
          ),
        );
        expect(await decision(id)).toMatchObject({
          state: "awaiting_evidence:1",
          spent: expect.objectContaining({ tool_calls: 1 }),
        });
        expect(await rounds(id)).toEqual([]);
      },
    },
    {
      name: "row 11: `awaiting_evidence(n)` | the evidence joins a child manifest whose `parent_id` is the current manifest",
      row: 11,
      from: "`awaiting_evidence(n)`",
      event:
        "the evidence joins a child manifest whose `parent_id` is the current manifest",
      to: "`round(n)`, and the next round cites the child manifest",
      drive: async () => {
        const id = await opened(11);
        await proposed(id);
        const pinned = (await decision(id)).manifest_id;
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "needs_evidence")],
            [sent(decider)],
          ),
        );
        await pass(
          delivery("delivery_e1", [evidence("e1", id, 1)], [sent(auditor)]),
        );
        const moved = await decision(id);
        expect(moved.state).toBe("round:1");
        expect(moved.manifest_id).not.toBe(pinned);
        expect((await conn.db.getManifest(moved.manifest_id))?.parent_id).toBe(
          pinned,
        );
        await pass(
          delivery(
            "delivery_a2",
            [audit("a2", id, 1, "disagree")],
            [sent(decider)],
          ),
        );
        expect(await rounds(id)).toEqual([
          { round: 1, stance: "disagree", manifest_id: moved.manifest_id },
        ]);
      },
    },
    {
      name: "row 12: `round(n)`, n below 3 | disagree",
      row: 12,
      from: "`round(n)`, n below 3",
      event: "disagree",
      to: "`round(n+1)`",
      drive: async () => {
        const id = await opened(12);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "disagree")],
            [sent(decider)],
          ),
        );
        expect(await decision(id)).toMatchObject({
          state: "round:2",
          closed_at: null,
        });
        expect(await rounds(id)).toMatchObject([
          { round: 1, stance: "disagree" },
        ]);
      },
    },
    {
      name: "row 13: `round(3)` | disagree",
      row: 13,
      from: "`round(3)`",
      event: "disagree",
      to: "`needs_human` with reason `disagreement`, carrying both final positions and the points of disagreement",
      drive: async () => {
        const id = await opened(13);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "disagree")],
            [sent(decider)],
          ),
        );
        await pass(
          delivery("delivery_p2", [proposal("p2", id, 2)], [sent(auditor)]),
        );
        await pass(
          delivery(
            "delivery_a2",
            [audit("a2", id, 2, "disagree")],
            [sent(decider)],
          ),
        );
        await pass(
          delivery("delivery_p3", [proposal("p3", id, 3)], [sent(auditor)]),
        );
        expect((await decision(id)).state).toBe("round:3");
        await pass(delivery("delivery_a3", [audit("a3", id, 3, "disagree")]));
        await settledAs(13, id, "needs_human", "disagreement");
        expect((await decisionEvents(id)).at(-1)?.payload).toMatchObject({
          outcome: "needs_human",
          reason: "disagreement",
          rounds: 3,
        });
        const [final] = await conn.sql<{ proposal: unknown; audit: unknown }[]>`
          select proposal, audit from ledger.decision_round
          where decision_id = ${id} and round = 3`;
        expect(final).toMatchObject({
          proposal: { proposal: "round 3 proposal" },
          audit: { stance: "disagree", points_of_disagreement: ["point 3"] },
        });
        expect(await taskState(planTask)).toBe("delivered");
      },
    },
    {
      name: "row 14: any open state | deadline, missing data, or an identity Pod cannot verify",
      row: 14,
      from: "any open state",
      event: "deadline, missing data, or an identity Pod cannot verify",
      to: "`needs_human` with reason `runtime-failure` or `context-missing`, with no rounds spent",
      drive: async () => {
        const id = await opened(14);
        await conn.sql`update ledger.decision
          set created_at = created_at - interval '7201 seconds' where id = ${id}`;
        await pass([
          ok("check", empty(), run),
          ok("worker-list", workers([]), run),
        ]);
        await settledAs(14, id, "needs_human", "runtime-failure");
        expect(
          (await decisionEvents(id)).map((row) => row.payload),
        ).toMatchObject([
          { outcome: "needs_human", budget_exhausted: "wall_clock" },
        ]);
        expect((await decision(id)).spent).toMatchObject({
          wall_clock: expect.any(Number),
        });
        expect(
          ((await decision(id)).spent as { wall_clock: number }).wall_clock,
        ).toBeGreaterThan(7200);
        expect(await rounds(id)).toEqual([]);
      },
    },
    {
      name: "row 15: any open state | budget exhausted",
      row: 15,
      from: "any open state",
      event: "budget exhausted",
      to: "`needs_human` with reason `runtime-failure`",
      drive: async () => {
        const id = await opened(15);
        await proposed(id);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", id, 1, "needs_evidence")],
            [sent(decider)],
          ),
        );
        await pass(
          delivery("delivery_e1", [evidence("e1", id, 1)], [sent(auditor)]),
        );
        await pass(
          delivery("delivery_a2", [audit("a2", id, 1, "needs_evidence")]),
        );
        await settledAs(15, id, "needs_human", "runtime-failure");
        expect((await decisionEvents(id)).at(-1)?.payload).toMatchObject({
          outcome: "needs_human",
          reason: "runtime-failure",
          budget_exhausted: "tool_calls",
        });
        expect((await decision(id)).spent).toMatchObject({ tool_calls: 2 });
        expect(await rounds(id)).toEqual([]);
      },
    },
    {
      name: "row 16: any open state | cancel by the escalating actor or the human",
      row: 16,
      from: "any open state",
      event: "cancel by the escalating actor or the human",
      to: "`cancelled`, the affected Task goes to `hold`, with no automatic reopen",
      drive: async () => {
        const id = await opened(16);
        await proposed(id);
        const cancelled = await cliReplay(conn, [
          "decide",
          "cancel",
          id,
          ...generation,
        ]);
        expect(cancelled.status, cancelled.json.error?.message).toBe(0);
        await settledAs(16, id, "cancelled", "cancelled");
        expect(await taskState(planTask)).toBe("hold");
        await pass([
          ok("check", empty(), run),
          ok("worker-list", workers([]), run),
        ]);
        expect((await decision(id)).state).toBe("cancelled");
        expect(await taskState(planTask)).toBe("hold");
      },
    },
    {
      name: "row 17: `round(n)` or `awaiting_evidence(n)` | Seat failure or coordinator interruption",
      row: 17,
      from: "`round(n)` or `awaiting_evidence(n)`",
      event: "Seat failure or coordinator interruption",
      to: "`needs_human` with reason `runtime-failure`, with no round spent",
      drive: async () => {
        failed = await failedAtOpen(17);
        await settledAs(17, failed, "needs_human", "runtime-failure");
        expect(await rounds(failed)).toEqual([]);
        expect(await resumeSpent(failed)).toMatchObject({ relaunches: 0 });
      },
    },
    {
      name: "row 18: `needs_human` with reason `runtime-failure` | a source-verified human ruling that says resume, within the `relaunches` budget, after the owner generation check",
      row: 18,
      from: "`needs_human` with reason `runtime-failure`",
      event:
        "a source-verified human ruling that says resume, within the `relaunches` budget, after the owner generation check",
      to: "`round(n)` for the interrupted round, with the same Decision id, rounds, and manifest, and the failed Seat's Dispatch reopened with a summary of earlier positions",
      drive: async () => {
        expect(failed).not.toBe("");
        const before = await decision(failed);
        const spent = before.spent as Record<string, number>;
        await pass(
          [
            ok("check", empty(), run),
            ...opensDecider,
            ok("worker-list", workers([]), run),
          ],
          {
            POD_TRACKER_FIXTURES: rulingTracker(story(17), [
              { id: "c-1", body: `decision ${failed} resume` },
            ]),
            POD_HOME: keeperHome(),
          },
        );
        const after = await decision(failed);
        expect(after).toMatchObject({
          id: failed,
          state: "round:1",
          manifest_id: before.manifest_id,
          closed_at: null,
        });
        expect(before.outcome).toMatchObject({ round: 1 });
        expect(after.spent).toMatchObject({
          relaunches: 1,
          tool_calls: spent["tool_calls"],
        });
        expect(
          (after.spent as { wall_clock: number }).wall_clock,
        ).toBeGreaterThanOrEqual(spent["wall_clock"] ?? 0);
        expect((await decisionEvents(failed)).at(-1)?.payload).toMatchObject({
          resumed_round: 1,
          ruling: { comment_id: "c-1", author: keeper, verb: "resume" },
        });
        expect(await conn.db.getDispatch(decider)).toMatchObject({
          decision_id: failed,
          role: "decider",
          settlement: "open",
        });
      },
    },
    {
      name: "row 19: `needs_human` with reason `runtime-failure` | a resume ruling when `relaunches` is spent",
      row: 19,
      from: "`needs_human` with reason `runtime-failure`",
      event: "a resume ruling when `relaunches` is spent",
      to: "Pod refuses the ruling with `decision_budget_exhausted`, and the Decision stays `needs_human`",
      drive: async () => {
        const id = await failedAtOpen(19);
        const home = keeperHome();
        const first = { id: "c-1", body: `decision ${id} resume` };
        await pass(
          [
            ok("check", empty(), run),
            ...failsDecider,
            ok("worker-list", workers([]), run),
          ],
          {
            POD_TRACKER_FIXTURES: rulingTracker(story(19), [first]),
            POD_HOME: home,
          },
        );
        expect(await decision(id)).toMatchObject({
          state: "needs_human",
          reason: "runtime-failure",
          spent: expect.objectContaining({ relaunches: 1 }),
        });
        const refused = await pass(
          [ok("check", empty(), run), ok("worker-list", workers([]), run)],
          {
            POD_TRACKER_FIXTURES: rulingTracker(story(19), [
              { id: "c-2", body: `decision ${id} resume` },
              first,
            ]),
            POD_HOME: home,
          },
        );
        expect(JSON.stringify(refused)).toContain("decision_budget_exhausted");
        expect(await decision(id)).toMatchObject({
          state: "needs_human",
          reason: "runtime-failure",
          spent: expect.objectContaining({ relaunches: 1 }),
        });
        expect((await decisionEvents(id)).at(-1)?.payload).toMatchObject({
          refused: "decision_budget_exhausted",
          budget_exhausted: "relaunches",
          ruling: { comment_id: "c-2", verb: "resume" },
        });
      },
    },
    {
      name: "row 20: `needs_human` | a human ruling comment that passes source verification and readback",
      row: 20,
      from: "`needs_human`",
      event:
        "a human ruling comment that passes source verification and readback",
      to: "`agreed` or `cancelled`, as the ruling says",
      drive: async () => {
        await plan(20);
        const held = await decide(
          questionFile({
            ...rollout,
            question: "Should the plan call the vendor first?",
          }),
          [],
        );
        expect(held.status, held.json.error?.message).toBe(0);
        const id = String(held.json.result?.["decision_id"]);
        await pass(
          [ok("check", empty(), run), ok("worker-list", workers([]), run)],
          {
            POD_TRACKER_FIXTURES: rulingTracker(story(20), [
              {
                id: "c-1",
                body: `decision ${id} agreed\nThe vendor call is approved.`,
              },
            ]),
            POD_HOME: keeperHome(),
          },
        );
        await settledAs(20, id, "agreed", "agreed");
        expect((await decision(id)).outcome).toMatchObject({
          text: "The vendor call is approved.",
        });
        expect((await decisionEvents(id)).at(-1)?.payload).toMatchObject({
          outcome: "agreed",
          ruling: { comment_id: "c-1", author: keeper, verb: "agreed" },
        });
        expect(await taskState(planTask)).toBe("done");
        expect(await taskState(implementTask)).toBe("ready");
      },
    },
    {
      name: "row 21: `agreed` | a later Decision cites this id",
      row: 21,
      from: "`agreed`",
      event: "a later Decision cites this id",
      to: "`superseded`, with `by` that Decision",
      drive: async () => {
        await plan(21);
        const first = await decide(
          specFile("Plan it in one release."),
          opensDecider,
          "change_spec",
        );
        expect(first.status, first.json.error?.message).toBe(0);
        const old = String(first.json.result?.["decision_id"]);
        await proposed(old);
        await pass(
          delivery(
            "delivery_a1",
            [audit("a1", old, 1, "agree")],
            [refusedReply("task-create", "failed", ["--run", "run_1"])],
          ),
        );
        expect((await decision(old)).state).toBe("agreed");
        const later = await decide(
          specFile("Plan it in two releases with a rollback step."),
          [sent(decider)],
          "change_spec",
          ["--supersedes", old],
        );
        expect(later.status, later.json.error?.message).toBe(0);
        const id = String(later.json.result?.["decision_id"]);
        await settledAs(21, old, "superseded", "superseded");
        expect((await decision(old)).outcome).toMatchObject({ by: id });
        expect(await conn.db.getOperation(supersedeOpKey(old))).toMatchObject({
          status: "refused",
          result_ref: expect.objectContaining({ superseded_by: id }),
        });
      },
    },
  ];

  test("the rows table mirrors the spec's Decision state table in order", () => {
    expect(rows.map((entry) => [entry.from, entry.event, entry.to])).toEqual(
      specTable(),
    );
    for (const [i, entry] of rows.entries()) {
      expect(entry.row).toBe(i + 1);
      expect(entry.name).toBe(
        `row ${entry.row}: ${entry.from} | ${entry.event}`,
      );
    }
  });

  for (const entry of rows) test(entry.name, entry.drive, 120_000);
});
