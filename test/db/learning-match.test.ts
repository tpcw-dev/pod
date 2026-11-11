import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { Scope } from "../../src/core/domain/config.ts";
import {
  addLearning,
  type LearningRow,
} from "../../src/core/learning/add.ts";
import {
  codePaths,
  evidenceId,
  matchLearning,
  normalizeExpected,
  reopenedAdoption,
} from "../../src/core/learning/match.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";

const start = new Date("2026-11-01T12:00:00.000Z");
const hour = 60 * 60 * 1000;

function at(hours: number): Date {
  return new Date(start.getTime() + hours * hour);
}

describe("matching, pure", () => {
  test("normalizeExpected folds case, punctuation, and whitespace", () => {
    expect(normalizeExpected("  Run the TESTS, first!\n\tthen ship. ")).toBe(
      "run the tests first then ship",
    );
    expect(normalizeExpected("ＡＢＣ")).toBe("abc");
    expect(normalizeExpected("?!")).toBeNull();
    expect(normalizeExpected(undefined)).toBeNull();
  });

  test("evidenceId dedups and sorts bytewise", () => {
    expect(evidenceId(["b", "a"])).toBe("a b");
    expect(evidenceId(["a", "b", "a"])).toBe("a b");
    expect(evidenceId(["é", "z", "Z"])).toBe("Z z é");
  });

  test("codePaths keeps repo:path refs and strips a line suffix", () => {
    expect([...codePaths(["pod:src/x.ts:40", "pod:src/y.ts:1-9"])]).toEqual([
      "pod:src/x.ts",
      "pod:src/y.ts",
    ]);
    expect([...codePaths(["pr:1", "comment:abc", "https://x.dev/a.b"])]).toEqual(
      [],
    );
  });

  test("matchLearning reads kind, expected text, and shared code paths", () => {
    const rows = [
      { id: 1, kind: "lead", expected: "ship it", evidence_refs: ["pr:1"] },
      { id: 2, kind: "lead", expected: null, evidence_refs: ["pod:src/a.ts"] },
      { id: 3, kind: "other", expected: "ship it", evidence_refs: ["pr:3"] },
    ];
    expect(
      matchLearning(rows, { kind: "lead", expected: "ship it", evidence_refs: ["pr:9"] }),
    ).toEqual([1]);
    expect(
      matchLearning(rows, {
        kind: "lead",
        expected: null,
        evidence_refs: ["pod:src/a.ts:12"],
      }),
    ).toEqual([2]);
    expect(
      matchLearning(rows, { kind: "lead", expected: null, evidence_refs: ["pr:1"] }),
    ).toEqual([]);
  });

  test("reopenedAdoption applies the rejected and done rules", () => {
    const rejected = { adoption: "rejected" as const, adoption_at: start };
    expect(reopenedAdoption(rejected, 1, at(1))).toBe("rejected");
    expect(reopenedAdoption(rejected, 2, at(1))).toBe("new");
    const done = { adoption: "done" as const, adoption_at: start };
    expect(reopenedAdoption(done, 1, at(72))).toBe("new");
    expect(reopenedAdoption(done, 1, at(73))).toBe("done");
    const adopted = { adoption: "adopted" as const, adoption_at: start };
    expect(reopenedAdoption(adopted, 5, at(1))).toBe("adopted");
  });
});

function row(over: Partial<LearningRow> = {}): LearningRow {
  return {
    source_story: "S-1",
    evidence_refs: ["pr:1"],
    text: "keep the seam",
    adoption: "new",
    area: "impl",
    project_id: null,
    kind: "lead",
    expected: null,
    reporter: "lead",
    ...over,
  };
}

describeDb("learning add matching", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  beforeEach(() => clearDb(conn));
  afterAll(() => conn.close());

  async function add(over: Partial<LearningRow>, now = start) {
    return addLearning(conn.db, { row: row(over), host: "h1", now: () => now });
  }

  async function added(over: Partial<LearningRow>, now = start) {
    const result = await add(over, now);
    if (!result.ok) throw new Error(result.refusal.message);
    return result;
  }

  async function counts() {
    const [n] = await conn.sql<
      { learnings: number; occurrences: number; events: number; ops: number }[]
    >`select
        (select count(*)::int from ledger.learning) as learnings,
        (select count(*)::int from ledger.learning_occurrence) as occurrences,
        (select count(*)::int from ledger.event where type = 'learning') as events,
        (select count(*)::int from ledger.operation where intent = 'learning') as ops`;
    return n;
  }

  async function adoptionOf(id: number) {
    const [r] = await conn.sql<{ adoption: string }[]>`
      select adoption from ledger.learning where id = ${id}`;
    return r?.adoption;
  }

  async function activateKinds(scope: Scope, scopeRef: string, kinds: string[]) {
    const revision = await storeRevision(conn.db, {
      ...envelope("policy", scopeRef === "" ? "default" : scopeRef, {
        learning: { kinds },
      } as Json),
      scope,
      scope_ref: scopeRef,
    });
    const activated = await conn.db.activate({
      scope,
      scope_ref: scopeRef,
      kind: "policy",
      name: scopeRef === "" ? "default" : scopeRef,
      expected: null,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: start,
    });
    if (!activated.ok) throw new Error("policy not activated");
  }

  test("equal normalized expected text lands on the existing row", async () => {
    const first = await added({ expected: "Run the tests first." });
    const second = await added({
      source_story: "S-2",
      text: "tests before ship",
      evidence_refs: ["pr:2"],
      expected: "run THE tests   first",
    });
    expect(second.id).toBe(first.id);
    expect(second.occurrence_id).not.toBe(first.occurrence_id);
    expect(await counts()).toMatchObject({ learnings: 1, occurrences: 2 });
    const [stored] = await conn.sql<{ expected: string }[]>`
      select expected from ledger.learning where id = ${first.id}`;
    expect(stored?.expected).toBe("run the tests first");
  });

  test("a shared code path lands on the existing row", async () => {
    const first = await added({ evidence_refs: ["pod:src/core/x.ts:10"] });
    const second = await added({
      text: "another wording",
      evidence_refs: ["pod:src/core/x.ts:99", "pr:7"],
    });
    expect(second.id).toBe(first.id);
    expect(await counts()).toMatchObject({ learnings: 1, occurrences: 2 });
  });

  test("two matching rows refuse learning_match_ambiguous and write nothing", async () => {
    const a = await added({ expected: "alpha", evidence_refs: ["pr:1"] });
    const b = await added({
      text: "other",
      evidence_refs: ["pod:src/b.ts"],
    });
    const before = await counts();
    const result = await add({
      text: "third",
      expected: "alpha",
      evidence_refs: ["pod:src/b.ts"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("learning_match_ambiguous");
    expect(result.refusal.message).toContain(`${a.id}, ${b.id}`);
    expect(result.refusal.nextSteps).toEqual([
      `pod learning add FILE --area impl --kind lead --repeat-of ${a.id}`,
      `pod learning add FILE --area impl --kind lead --repeat-of ${b.id}`,
    ]);
    expect(await counts()).toEqual(before);
  });

  test("--repeat-of skips the match, and an unknown id is schema_invalid", async () => {
    const a = await added({ expected: "alpha" });
    const repeat = await added({
      text: "unrelated",
      evidence_refs: ["pr:5"],
      repeat_of: a.id,
    });
    expect(repeat.id).toBe(a.id);
    expect(await counts()).toMatchObject({ learnings: 1, occurrences: 2 });

    const missing = await add({ evidence_refs: ["pr:6"], repeat_of: 999 });
    expect(missing).toMatchObject({
      ok: false,
      refusal: { code: "schema_invalid", nextSteps: ["repeat-of"] },
    });
  });

  test("a repeated evidence id is one occurrence", async () => {
    const a = await added({ expected: "alpha", evidence_refs: ["pr:2", "pr:1"] });
    const again = await added({
      text: "same source, new words",
      expected: "alpha",
      evidence_refs: ["pr:1", "pr:2", "pr:1"],
    });
    expect(again.id).toBe(a.id);
    expect(again.occurrence_id).toBe(a.occurrence_id);
    expect(await counts()).toMatchObject({ learnings: 1, occurrences: 1 });
  });

  test("a replay returns the same occurrence id", async () => {
    const first = await added({ expected: "alpha" });
    const replay = await added({ expected: "alpha" });
    expect(replay).toMatchObject({
      id: first.id,
      occurrence_id: first.occurrence_id,
      replayed: true,
    });
  });

  test("a rejected row returns to new only on its second new occurrence", async () => {
    const a = await added({ expected: "alpha", adoption: "rejected" });
    await conn.sql`update ledger.learning set adoption_at = ${at(1).toISOString()} where id = ${a.id}`;
    await added({ expected: "alpha", evidence_refs: ["pr:2"] }, at(2));
    expect(await adoptionOf(a.id)).toBe("rejected");
    await added({ expected: "alpha", evidence_refs: ["pr:3"] }, at(3));
    expect(await adoptionOf(a.id)).toBe("new");
  });

  test("a done row reopens within 72 hours and not after", async () => {
    const a = await added({ expected: "alpha" });
    await conn.sql`update ledger.learning set adoption = 'done', adoption_at = ${start.toISOString()} where id = ${a.id}`;
    await added({ expected: "alpha", evidence_refs: ["pr:2"] }, at(72));
    expect(await adoptionOf(a.id)).toBe("new");

    const b = await added({ expected: "beta", evidence_refs: ["pr:10"] });
    await conn.sql`update ledger.learning set adoption = 'done', adoption_at = ${start.toISOString()} where id = ${b.id}`;
    await added({ expected: "beta", evidence_refs: ["pr:11"] }, at(73));
    expect(await adoptionOf(b.id)).toBe("done");
  });

  test("an unknown kind is learning_kind_unknown, writes nothing, and passes once a Revision allows it", async () => {
    const refused = await add({ kind: "kind_a" });
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "learning_kind_unknown" },
    });
    if (!refused.ok)
      expect(refused.refusal.nextSteps[0]).toBe("allowed kinds: lead");
    expect(await counts()).toEqual({
      learnings: 0,
      occurrences: 0,
      events: 0,
      ops: 0,
    });
    await activateKinds("global", "", ["lead", "kind_a"]);
    const retried = await added({ kind: "kind_a" });
    expect(retried.replayed).toBe(false);
  });

  test("a project policy's kinds apply, and a project without one falls back to global", async () => {
    await activateKinds("global", "", ["lead", "kind_b"]);
    await activateKinds("project", "alpha", ["lead", "kind_a"]);
    expect((await add({ kind: "kind_a", project_id: "alpha" })).ok).toBe(true);
    expect(
      await add({ kind: "kind_b", project_id: "alpha", evidence_refs: ["pr:2"] }),
    ).toMatchObject({ ok: false, refusal: { code: "learning_kind_unknown" } });
    expect(
      (await add({ kind: "kind_b", project_id: "beta", evidence_refs: ["pr:3"] }))
        .ok,
    ).toBe(true);
  });

  test("the CLI refuses an unknown kind with exit 3 and the event carries kind and occurrence_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-learning-"));
    const path = join(dir, "learning.yaml");
    writeFileSync(
      path,
      "source_story: S-1\nevidence_refs: [pr:1]\ntext: keep the seam\n",
    );
    const refused = runCli(["learning", "add", path, "--area", "impl", "--kind", "kind_z"]);
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("learning_kind_unknown");

    const ok = runCli(["learning", "add", path, "--area", "impl", "--kind", "lead"]);
    expect(ok.status).toBe(0);
    const occurrence = ok.json.result?.["occurrence_id"];
    const [event] = await conn.sql<{ payload: Record<string, unknown> }[]>`
      select payload from ledger.event where type = 'learning'`;
    expect(event?.payload).toMatchObject({ kind: "lead", occurrence_id: occurrence });

    const bad = runCli(["learning", "add", path, "--area", "impl", "--kind", "lead", "--repeat-of", "x"]);
    expect(bad.status).toBe(2);
    const reporter = runCli(["learning", "add", path, "--area", "impl", "--kind", "lead", "--reporter", "bot"]);
    expect(reporter.status).toBe(2);
  });
});
