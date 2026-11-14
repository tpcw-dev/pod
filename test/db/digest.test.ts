import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Scope } from "../../src/core/domain/config.ts";
import {
  acceptProposalFile,
  type ProposalFileRow,
} from "../../src/core/domain/digest.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { digestBrief } from "../../src/core/digest/brief.ts";
import { decideDigest } from "../../src/core/digest/decide.ts";
import { postDigest } from "../../src/core/digest/post.ts";
import { prepareDigest } from "../../src/core/digest/prepare.ts";
import { assignStory, digestQueue } from "../../src/core/digest/queue.ts";
import { addLearning } from "../../src/core/learning/add.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { seatRun } from "./identity-fixture.ts";

const day1 = new Date("2026-11-10T12:00:00.000Z");
const day2 = new Date("2026-11-11T12:00:00.000Z");
const actor = "person:human";

function proposal(
  theme: string,
  learningIds: number[],
  text = `${theme} proposal`,
): ProposalFileRow {
  return {
    theme,
    text,
    learning_ids: learningIds,
    evidence_refs: learningIds.map((id) => `learning:${id}`),
  };
}

function yamlFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pod-digest-"));
  const path = join(dir, "proposals.yaml");
  writeFileSync(path, body);
  return path;
}

describe("proposal file, pure", () => {
  test("a learning id in two proposals of one file is schema_invalid", () => {
    const accepted = acceptProposalFile([
      proposal("gates", [1]),
      proposal("tests", [2, 1]),
    ]);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok)
      expect(accepted.issues).toEqual([
        "proposals[1].learning_ids: repeats learning 1",
      ]);
  });

  test("an unknown key, an empty list of ids, and a duplicate id are named", () => {
    const accepted = acceptProposalFile([
      { ...proposal("gates", [1]), extra: true },
      { ...proposal("tests", []) },
      { ...proposal("docs", [3, 3]) },
    ]);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok)
      expect(accepted.issues).toEqual([
        "proposals[0].extra: unknown key",
        "proposals[1].learning_ids: Too small: expected array to have >=1 items",
        "proposals[2].learning_ids: repeats learning 3",
      ]);
  });

  test("an empty list is a valid file", () => {
    expect(acceptProposalFile([])).toEqual({ ok: true, proposals: [] });
  });
});

describeDb("pod digest", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function activatePolicy(scope: Scope, scopeRef: string, value: Json) {
    const name = scopeRef === "" ? "default" : scopeRef;
    const revision = await storeRevision(conn.db, {
      ...envelope("policy", name, value),
      scope,
      scope_ref: scopeRef,
    });
    const activated = await conn.db.activate({
      scope,
      scope_ref: scopeRef,
      kind: "policy",
      name,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: day1,
    });
    if (!activated.ok) throw new Error("policy not activated");
  }

  async function learn(
    text: string,
    options: { project?: string; now?: Date } = {},
  ): Promise<number> {
    const added = await addLearning(conn.db, {
      row: {
        source_story: "S-1",
        evidence_refs: [`pr:${text}`],
        text,
        adoption: "new",
        area: "process",
        project_id: options.project ?? null,
        kind: "lead",
        reporter: "lead",
      },
      host: "local",
      now: () => options.now ?? day1,
    });
    if (!added.ok) throw new Error(added.refusal.message);
    return added.id;
  }

  async function adoptionOf(id: number) {
    const [row] = await conn.sql<
      { adoption: string; theme: string | null; action_story: string | null }[]
    >`select adoption, theme, action_story from ledger.learning where id = ${id}`;
    return row;
  }

  async function counts() {
    const [row] = await conn.sql<
      { proposals: number; events: number; ops: number; learnings: number }[]
    >`select
        (select count(*)::int from ledger.digest_proposal) as proposals,
        (select count(*)::int from ledger.event) as events,
        (select count(*)::int from ledger.operation) as ops,
        (select count(*)::int from ledger.learning) as learnings`;
    return row;
  }

  async function post(proposals: ProposalFileRow[], now = day1, project: string | null = null) {
    const posted = await postDigest(conn.db, {
      project,
      proposals,
      host: "local",
      now: () => now,
    });
    if (!posted.ok) throw new Error(posted.refusal.message);
    return posted;
  }

  async function failReceipt(at: Date, project: string | null) {
    const runId = `run-${at.getTime()}`;
    await seatRun(conn.db, runId);
    const policy = await storeRevision(
      conn.db,
      envelope("policy", `p-${runId}`, {} as Json),
    );
    await conn.db.insertSnapshot({
      run_id: runId,
      crew_revision_id: policy.id,
      process_revision_id: policy.id,
      policy_revision_id: policy.id,
      rate_revision_id: null,
      effective_gate_map: {},
      hash: "hash",
      pinned_at: at,
      project,
      profile: null,
    });
    await conn.db.insertTask({
      task_id: `task-${runId}`,
      run_id: runId,
      step_id: "review",
      lineage_id: `task-${runId}`,
      role: "reviewer",
      deps: [],
      spec_revision_id: policy.id,
      state: "failed",
      created_at: at,
      rework_of: null,
    });
    return conn.db.insertGateReceipt({
      gate_id: "pr",
      run_id: runId,
      task_id: `task-${runId}`,
      scope: "story",
      spec_revision_id: policy.id,
      candidate_sha: "0123456789abcdef0123456789abcdef01234567",
      deployed_revision: null,
      keeper: "reviewer",
      outcome: "FAIL",
      source: {},
      sync_state: "synced",
      created_at: at,
    });
  }

  test("prepare lists new learnings, FAIL receipts of the last 72 hours, and the watermark, and writes nothing", async () => {
    const a = await learn("gate first");
    const b = await learn("other project", { project: "alpha" });
    const recent = await failReceipt(new Date(day1.getTime() - 3600_000), null);
    await failReceipt(new Date(day1.getTime() - 73 * 3600_000), null);
    const before = await counts();
    const packet = await prepareDigest(conn.db, { project: null, now: () => day1 });
    expect(await counts()).toEqual(before);
    expect(packet).toMatchObject({
      scope: "global",
      day: "2026-11-10",
      cap: 3,
      watermark: null,
      queued: [],
    });
    expect(packet.learnings.map((row) => row.id)).toEqual([a]);
    expect(packet.fail_receipts.map((row) => row.id)).toEqual([recent.id]);
    const alpha = await prepareDigest(conn.db, { project: "alpha", now: () => day1 });
    expect(alpha.scope).toBe("project:alpha");
    expect(alpha.learnings.map((row) => row.id)).toEqual([b]);
    expect(alpha.fail_receipts).toEqual([]);
    await post([proposal("gates", [a])]);
    const after = await prepareDigest(conn.db, { project: null, now: () => day1 });
    expect(after.watermark).toBe(day1.toISOString());
    expect(after.learnings).toEqual([]);
  });

  test("a cap of 3 shows three, queues the fourth, and the next day shows the queued one first", async () => {
    await activatePolicy("global", "", { limits: { digest_per_day: 3 } } as Json);
    const ids = [
      await learn("one"),
      await learn("two"),
      await learn("three"),
      await learn("four"),
      await learn("five"),
    ];
    const first = await post(ids.slice(0, 4).map((id, n) => proposal(`t${n}`, [id])));
    expect(first).toMatchObject({ scope: "global", day: "2026-11-10", cap: 3, queued: 1, replayed: false });
    expect(first.shown.map((row) => row.theme)).toEqual(["t0", "t1", "t2"]);
    expect(first.shown.every((row) => !row.carried)).toBe(true);
    expect(await adoptionOf(ids[0] ?? 0)).toMatchObject({ adoption: "proposed", theme: "t0" });
    expect(await adoptionOf(ids[3] ?? 0)).toMatchObject({ adoption: "new", theme: null });
    const packet = await prepareDigest(conn.db, { project: null, now: () => day1 });
    expect(packet.queued.map((row) => row.theme)).toEqual(["t3"]);
    expect(packet.learnings.map((row) => row.id)).toEqual([ids[4]]);

    const second = await post([proposal("t4", [ids[4] ?? 0])], day2);
    expect(second.day).toBe("2026-11-11");
    expect(second.shown.map((row) => [row.theme, row.carried])).toEqual([
      ["t3", true],
      ["t4", false],
    ]);
    expect(second.shown[0]?.number).toBeLessThan(second.shown[1]?.number ?? 0);
    expect(second.queued).toBe(0);
    const events = await conn.sql<{ op_key: string; payload: Json }[]>`
      select op_key, payload from ledger.event where type = 'digest' order by id`;
    expect(events.map((row) => row.op_key)).toEqual([
      "digest:global:2026-11-10",
      "digest:global:2026-11-11",
    ]);
    expect(events[0]?.payload).toMatchObject({ cap: 3, queued: [{ theme: "t3" }] });
  });

  test("a second post on the same day queues its proposals, and a re-post of the same file is a replay", async () => {
    await activatePolicy("global", "", { limits: { digest_per_day: 3 } } as Json);
    const a = await learn("a");
    const b = await learn("b");
    await post([proposal("gates", [a])]);
    const again = await post([proposal("gates", [a])]);
    expect(again).toMatchObject({ replayed: true, queued: 0 });
    expect(again.shown.map((row) => row.theme)).toEqual(["gates"]);
    const later = await post([proposal("tests", [b])]);
    expect(later).toMatchObject({ replayed: false, queued: 1 });
    expect(later.shown.map((row) => row.theme)).toEqual(["gates"]);
    expect(await adoptionOf(b)).toMatchObject({ adoption: "new" });
    expect(await counts()).toMatchObject({ proposals: 2 });
  });

  test("a project policy's cap overrides the global one", async () => {
    await activatePolicy("global", "", { limits: { digest_per_day: 3 } } as Json);
    await activatePolicy("project", "alpha", { limits: { digest_per_day: 1 } } as Json);
    const a = await learn("a", { project: "alpha" });
    const b = await learn("b", { project: "alpha" });
    const posted = await post([proposal("x", [a]), proposal("y", [b])], day1, "alpha");
    expect(posted).toMatchObject({ scope: "project:alpha", cap: 1, queued: 1 });
  });

  test("post refuses a learning from another scope, one not new, and one in an unruled proposal, and writes nothing", async () => {
    const a = await learn("a");
    const other = await learn("other", { project: "alpha" });
    await post([proposal("gates", [a])]);
    const before = await counts();
    for (const proposals of [
      [proposal("x", [other])],
      [proposal("y", [a])],
      [proposal("z", [999])],
    ]) {
      const refused = await postDigest(conn.db, {
        project: null,
        proposals,
        host: "local",
        now: () => day2,
      });
      expect(refused).toMatchObject({ ok: false, refusal: { code: "schema_invalid" } });
    }
    expect(await counts()).toEqual(before);
  });

  test("decide accept and reject move the learnings and write ruling events", async () => {
    const a = await learn("a");
    const b = await learn("b");
    const posted = await post([proposal("gates", [a]), proposal("tests", [b])]);
    const [gates, tests] = posted.shown;
    const accepted = await decideDigest(conn.db, {
      number: gates?.number ?? 0,
      verdict: "accept",
      reason: "worth it",
      actor,
      host: "local",
      now: () => day2,
    });
    expect(accepted).toMatchObject({ ok: true, day: "2026-11-10", verdict: "accept", learning_ids: [a] });
    await decideDigest(conn.db, {
      number: tests?.number ?? 0,
      verdict: "reject",
      reason: "noise",
      actor,
      host: "local",
      now: () => day2,
    });
    expect(await adoptionOf(a)).toMatchObject({ adoption: "adopted" });
    expect(await adoptionOf(b)).toMatchObject({ adoption: "rejected" });
    const rulings = await conn.sql<{ op_key: string; payload: Json }[]>`
      select op_key, payload from ledger.event where type = 'ruling' order by id`;
    expect(rulings.map((row) => row.op_key)).toEqual([
      `ruling:${gates?.number}`,
      `ruling:${tests?.number}`,
    ]);
    expect(rulings[0]?.payload).toEqual({
      scope: "global",
      day: "2026-11-10",
      number: gates?.number,
      verdict: "accept",
      reason: "worth it",
      learning_ids: [a],
      actor,
    });
    const brief = await digestBrief(conn.db, null, () => day1);
    expect(brief).toMatchObject({ shown: 2, open: 0 });
  });

  test("a second ruling on the same proposal is refused ruling_exists, and a queued one schema_invalid", async () => {
    await activatePolicy("global", "", { limits: { digest_per_day: 1 } } as Json);
    const a = await learn("a");
    const b = await learn("b");
    await post([proposal("gates", [a]), proposal("tests", [b])]);
    const [shown] = (await post([])).shown;
    const input = {
      verdict: "accept" as const,
      reason: "ok",
      actor,
      host: "local",
      now: () => day1,
    };
    expect(await decideDigest(conn.db, { ...input, number: shown?.number ?? 0 })).toMatchObject({ ok: true });
    expect(
      await decideDigest(conn.db, { ...input, number: shown?.number ?? 0, verdict: "reject" }),
    ).toMatchObject({ ok: false, refusal: { code: "ruling_exists" } });
    const queued = await prepareDigest(conn.db, { project: null, now: () => day1 });
    expect(
      await decideDigest(conn.db, { ...input, number: queued.queued[0]?.number ?? 0 }),
    ).toMatchObject({ ok: false, refusal: { code: "schema_invalid" } });
    expect(await adoptionOf(a)).toMatchObject({ adoption: "adopted" });
  });

  test("after a reject and a return to new, the same proposal posts as a new number", async () => {
    const a = await learn("a");
    const [first] = (await post([proposal("gates", [a])])).shown;
    await decideDigest(conn.db, {
      number: first?.number ?? 0,
      verdict: "reject",
      reason: "not yet",
      actor,
      host: "local",
      now: () => day1,
    });
    await conn.db.setLearningAdoption(a, "new", day2);
    const [second] = (await post([proposal("gates", [a])], day2)).shown;
    expect(second?.number).toBeGreaterThan(first?.number ?? 0);
    expect(await adoptionOf(a)).toMatchObject({ adoption: "proposed" });
  });

  test("queue groups accepted rows with no action Story by theme, and assign sets the action Story", async () => {
    const ids = [await learn("a"), await learn("b"), await learn("c")];
    const posted = await post([
      proposal("gates", [ids[0] ?? 0, ids[1] ?? 0]),
      proposal("tests", [ids[2] ?? 0]),
    ]);
    for (const shown of posted.shown)
      await decideDigest(conn.db, {
        number: shown.number,
        verdict: "accept",
        reason: "ok",
        actor,
        host: "local",
        now: () => day1,
      });
    const queue = await digestQueue(conn.db, null);
    expect(queue.scope).toBe("global");
    expect(queue.themes.map((group) => [group.theme, group.learnings.map((row) => row.id)])).toEqual([
      ["gates", [ids[0], ids[1]]],
      ["tests", [ids[2]]],
    ]);
    expect(await assignStory(conn.db, { id: ids[2] ?? 0, story: "S-40" })).toEqual({
      ok: true,
      id: ids[2],
      action_story: "S-40",
      changed: true,
    });
    expect(await assignStory(conn.db, { id: ids[2] ?? 0, story: "S-40" })).toMatchObject({ changed: false });
    expect(await adoptionOf(ids[2] ?? 0)).toMatchObject({ action_story: "S-40" });
    const after = await digestQueue(conn.db, null);
    expect(after.themes.map((group) => group.theme)).toEqual(["gates"]);
    expect(await digestBrief(conn.db, null, () => day1)).toMatchObject({ queue: 2 });
    const fresh = await learn("d");
    expect(await assignStory(conn.db, { id: fresh, story: "S-41" })).toMatchObject({
      ok: false,
      refusal: { code: "schema_invalid" },
    });
  });

  test("the brief view counts today's shown, the queue, and the open rulings", async () => {
    await activatePolicy("global", "", { limits: { digest_per_day: 2 } } as Json);
    const ids = [await learn("a"), await learn("b"), await learn("c")];
    await post(ids.map((id, n) => proposal(`t${n}`, [id])));
    const brief = await digestBrief(conn.db, null, () => day1);
    expect(brief).toMatchObject({ cap: 2, shown: 2, queued: 1, open: 2, queue: 0 });
    expect(brief.proposals.map((row) => [row.theme, row.ruling])).toEqual([
      ["t0", "open"],
      ["t1", "open"],
    ]);
    expect(await digestBrief(conn.db, null, () => day2)).toMatchObject({ shown: 0, open: 2, proposals: [] });
  });

  test("the CLI posts a file, and an agent Seat is refused digest decide while it may still add a learning", async () => {
    const a = await learn("a");
    const posted = runCli([
      "digest",
      "post",
      yamlFile(`- theme: gates\n  text: Check the gate first\n  learning_ids: [${a}]\n  evidence_refs: [pr:1]\n`),
    ]);
    expect(posted.status).toBe(0);
    const shown = posted.json.result?.["shown"] as { number: number }[];
    const number = String(shown[0]?.number);
    const seat = runCli(
      ["digest", "decide", number, "--accept", "--reason", "ok"],
      { POD_SEAT: "seat-1" },
    );
    expect(seat.status).toBe(3);
    expect(seat.json.error?.code).toBe("activation_needs_person");
    const learning = yamlFile("source_story: S-2\nevidence_refs: [pr:9]\ntext: seat lesson\n");
    expect(
      runCli(["learning", "add", learning, "--area", "impl", "--kind", "lead"], { POD_SEAT: "seat-1" })
        .status,
    ).toBe(0);
    const person = runCli(["digest", "decide", number, "--accept", "--reason", "ok"]);
    expect(person.status).toBe(0);
    expect(person.json.result).toMatchObject({ verdict: "accept", learning_ids: [a] });
    const [event] = await conn.sql<{ payload: Json }[]>`
      select payload from ledger.event where type = 'ruling'`;
    expect(event?.payload).toMatchObject({ actor: "person:human" });
  });

  test("the CLI refuses a second ruling and a double verdict, and assign and queue read the rows", async () => {
    const a = await learn("a");
    const [shown] = (await post([proposal("gates", [a])], new Date())).shown;
    const number = String(shown?.number);
    expect(runCli(["digest", "decide", number, "--accept", "--reject", "--reason", "x"]).status).toBe(2);
    expect(runCli(["digest", "decide", number, "--accept", "--reason", "ok"]).status).toBe(0);
    const again = runCli(["digest", "decide", number, "--reject", "--reason", "no"]);
    expect(again.status).toBe(3);
    expect(again.json.error?.code).toBe("ruling_exists");
    expect(runCli(["digest", "assign", String(a), "story:S-9"]).json.result).toMatchObject({
      action_story: "S-9",
      changed: true,
    });
    expect(runCli(["digest", "queue"]).json.result).toEqual({ scope: "global", themes: [] });
    expect(runCli(["digest", "prepare"]).status).toBe(0);
  });
});
