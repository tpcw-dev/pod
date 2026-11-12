import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { acceptProposalFile } from "../../src/core/domain/digest.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { decideDigest } from "../../src/core/digest/decide.ts";
import { postDigest } from "../../src/core/digest/post.ts";
import { prepareDigest } from "../../src/core/digest/prepare.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const dir = "test/replay/digest-day";
const day1 = new Date("2026-11-10T09:00:00.000Z");
const day2 = new Date("2026-11-11T09:00:00.000Z");

function proposals(name: string) {
  const accepted = acceptProposalFile(
    parse(readFileSync(`${dir}/${name}.yaml`, "utf8")),
  );
  if (!accepted.ok) throw new Error(accepted.issues.join("; "));
  return accepted.proposals;
}

describeDb("digest day", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    const applied = runCli([
      "config",
      "apply",
      `${dir}/policy.yaml`,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(applied.status).toBe(0);
    for (const n of [1, 2, 3, 4]) {
      const added = runCli([
        "learning",
        "add",
        `${dir}/learning-${n}.yaml`,
        "--area",
        "process",
        "--kind",
        "lead",
      ]);
      expect(added.json.result?.["id"]).toBe(n);
    }
  });
  afterAll(() => conn.close());

  test("two days of digest: a cap of 2 queues the third proposal, the next day shows it, and the rulings land in the ledger", async () => {
    const packet = await prepareDigest(conn.db, { project: null, now: () => day1 });
    expect(packet).toMatchObject({ cap: 2, watermark: null, queued: [] });
    expect(packet.learnings.map((row) => row.id)).toEqual([1, 2, 3, 4]);

    const first = await postDigest(conn.db, {
      project: null,
      proposals: proposals("day1"),
      host: "local",
      now: () => day1,
    });
    expect(first).toMatchObject({ ok: true, cap: 2, queued: 1 });
    if (!first.ok) return;
    expect(first.shown.map((row) => row.theme)).toEqual(["gates", "tests"]);
    for (const [index, verdict] of [
      [0, "accept"],
      [1, "reject"],
    ] as const) {
      const ruled = await decideDigest(conn.db, {
        number: first.shown[index]?.number ?? 0,
        verdict,
        reason: `${verdict} on day one`,
        actor: "person:human",
        host: "local",
        now: () => day1,
      });
      expect(ruled.ok).toBe(true);
    }

    const second = await postDigest(conn.db, {
      project: null,
      proposals: proposals("day2"),
      host: "local",
      now: () => day2,
    });
    expect(second).toMatchObject({ ok: true, day: "2026-11-11", queued: 0 });
    if (!second.ok) return;
    expect(second.shown.map((row) => [row.theme, row.carried])).toEqual([
      ["docs", true],
    ]);

    const learnings = await conn.sql<{ id: number; adoption: string; theme: string | null }[]>`
      select id::int as id, adoption, theme from ledger.learning order by id`;
    expect(learnings).toEqual([
      { id: 1, adoption: "adopted", theme: "gates" },
      { id: 2, adoption: "adopted", theme: "gates" },
      { id: 3, adoption: "rejected", theme: "tests" },
      { id: 4, adoption: "proposed", theme: "docs" },
    ]);
    const events = await conn.sql<{ type: string; op_key: string; payload: Json }[]>`
      select type, op_key, payload from ledger.event
      where type in ('digest', 'ruling') order by id`;
    expect(events.map((row) => [row.type, row.op_key])).toEqual([
      ["digest", "digest:global:2026-11-10"],
      ["ruling", `ruling:${first.shown[0]?.number}`],
      ["ruling", `ruling:${first.shown[1]?.number}`],
      ["digest", "digest:global:2026-11-11"],
    ]);

    const queue = runCli(["digest", "queue"]);
    expect(queue.json.result).toMatchObject({
      scope: "global",
      themes: [{ theme: "gates", learnings: [{ id: 1 }, { id: 2 }] }],
    });
    expect(runCli(["digest", "assign", "1", "story:S-50"]).status).toBe(0);
    expect(runCli(["digest", "assign", "3", "story:S-50"]).json.error?.code).toBe(
      "schema_invalid",
    );
    const after = runCli(["digest", "queue"]).json.result as {
      themes: { learnings: { id: number }[] }[];
    };
    expect(after.themes.flatMap((group) => group.learnings.map((row) => row.id))).toEqual([2]);
  });
});
