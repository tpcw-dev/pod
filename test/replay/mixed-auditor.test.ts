import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import {
  applyConfig,
  audit,
  cliDeliveredPlan,
  cliReplay,
  decideArgs,
  decider,
  delivery,
  opensAuditor,
  opensDecider,
  proposal,
  questionFile,
  sent,
} from "../db/decision-fixture.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const Truth = z.enum(["accept", "reject"]);
const Classification = z.enum(["hit", "miss", "false_refusal"]);
type Classification = z.infer<typeof Classification>;

const Case = z.strictObject({
  id: z.string().min(1),
  name: z.enum([
    "correct-proposal",
    "wrong-citation",
    "stale-roadmap",
    "out-of-scope",
    "true-citation-wrong-inference",
  ]),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  proposal: z.strictObject({
    text: z.string().min(1),
    citations: z.array(z.string().min(1)).min(1),
  }),
  truth: Truth,
  audit: z.strictObject({
    stance: z.enum(["agree", "disagree"]),
    reasons: z.array(z.string().min(1)).min(1),
  }),
  expected: Classification,
});
type Case = z.infer<typeof Case>;

const cases = z
  .array(Case)
  .length(5)
  .parse(parse(readFileSync("test/replay/mixed-auditor/cases.yaml", "utf8")));

function classify(
  stance: string,
  truth: z.infer<typeof Truth>,
): Classification {
  if ((stance === "agree") === (truth === "accept")) return "hit";
  return stance === "agree" ? "miss" : "false_refusal";
}

interface Recorded {
  story: string;
  decision: string;
  classification: Classification;
}

describeDb("mixed auditor set", () => {
  let conn: Connection;
  const recorded = new Map<string, Recorded>();

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    applyConfig([
      "test/replay/decision-states/policy.yaml",
      "test/replay/decision-states/crew.yaml",
      "test/replay/decision-states/process.yaml",
      "specs/decision/default.yaml",
    ]);
  });
  afterAll(() => conn.close());

  async function check(orca: Parameters<typeof cliReplay>[2]) {
    const result = await cliReplay(
      conn,
      ["check", "--run", "run_1", "--generation", "1"],
      orca,
    );
    expect(result.status, result.json.error?.message).toBe(0);
  }

  async function drive(item: Case, story: string): Promise<Recorded> {
    await cliDeliveredPlan(conn, story, "decision-states@1");
    const opened = await cliReplay(
      conn,
      decideArgs(
        questionFile({ question: item.question, options: item.options }),
      ),
      opensDecider,
    );
    expect(opened.status, opened.json.error?.message).toBe(0);
    const id = String(opened.json.result?.["decision_id"]);
    await check(
      delivery(
        "delivery_p1",
        [proposal("p1", id, 1, item.proposal.citations, item.proposal.text)],
        opensAuditor,
      ),
    );
    await check(
      delivery(
        "delivery_a1",
        [audit("a1", id, 1, item.audit.stance, undefined, item.audit.reasons)],
        item.audit.stance === "agree" ? [] : [sent(decider)],
      ),
    );
    const [round] = await conn.sql<{ stance: string; proposal: unknown }[]>`
      select stance, proposal from ledger.decision_round
      where decision_id = ${id} and round = 1`;
    expect(round?.proposal).toMatchObject({ proposal: item.proposal.text });
    return {
      story,
      decision: id,
      classification: classify(round?.stance ?? "", item.truth),
    };
  }

  for (const [i, item] of cases.entries())
    test(`${item.id} ${item.name} is classified ${item.expected}`, async () => {
      const found = await drive(item, `TRK-${101 + i}`);
      expect(found.classification).toBe(item.expected);
      recorded.set(item.id, found);
    }, 60_000);

  test("the set exercises both failure classes", () => {
    expect(cases.map((item) => item.expected).sort()).toEqual([
      "false_refusal",
      "hit",
      "hit",
      "hit",
      "miss",
    ]);
  });

  test("each case is recorded as one learning row", () => {
    expect(recorded.size).toBe(cases.length);
    const dir = mkdtempSync(join(tmpdir(), "pod-mixed-auditor-"));
    for (const [id, found] of recorded) {
      const file = join(dir, `${id}.yaml`);
      writeFileSync(
        file,
        stringify({
          source_story: found.story,
          evidence_refs: [found.decision],
          text: `${id}: ${found.classification}`,
        }),
      );
      const added = runCli(["learning", "add", file, "--area", "process"]);
      expect(added.status, added.json.error?.message).toBe(0);
    }
    const queried = runCli(["learning", "query", "--area", "process"]);
    expect(queried.status).toBe(0);
    const rows = z
      .array(
        z.looseObject({
          source_story: z.string(),
          evidence_refs: z.array(z.string()),
          text: z.string(),
        }),
      )
      .parse(queried.json.result?.["learnings"]);
    expect(
      rows.map((row) => [row.text, row.source_story, row.evidence_refs]).sort(),
    ).toEqual(
      [...recorded]
        .map(([id, found]) => [
          `${id}: ${found.classification}`,
          found.story,
          [found.decision],
        ])
        .sort(),
    );
  });
});
