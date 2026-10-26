import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { applyConfig, type ApplyInput } from "../../src/core/config/apply.ts";
import { envelope } from "./fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

function input(value: string, expected: string | null): ApplyInput {
  return {
    envelope: envelope("process", "race", { value }),
    actor: "operator",
    reason: "",
    now: new Date(),
    activate: { expected, opKey: null, host: "local" },
  };
}

describeDb("CAS conflict", () => {
  let one: Connection;
  let two: Connection;

  beforeAll(async () => {
    await resetDb();
    one = openDb();
    two = openDb();
  });
  afterAll(async () => {
    await one.close();
    await two.close();
  });

  test("two applies with one expected Revision: exactly one wins", async () => {
    const base = await applyConfig(one.db, input("base", null));
    if (base.kind !== "ok") throw new Error(base.kind);
    const results = await Promise.all([
      applyConfig(one.db, input("left", base.result.id)),
      applyConfig(two.db, input("right", base.result.id)),
    ]);
    const winners = results.flatMap((r) => (r.kind === "ok" ? [r.result] : []));
    const losers = results.flatMap((r) =>
      r.kind === "revision_conflict" ? [r] : [],
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [winner] = winners;
    const [loser] = losers;
    expect(loser?.active?.id).toBe(winner?.id);
    const active = await one.db.getActivation({
      scope: "global",
      scope_ref: "",
      kind: "process",
      name: "race",
    });
    expect(active).toMatchObject({
      revision_id: winner?.id,
      previous_revision_id: base.result.id,
    });
    expect(await one.db.getOperation(loser?.opKey ?? "")).toMatchObject({
      status: "refused",
    });
    const events =
      await one.sql`select 1 from ledger.event where type = 'activation'`;
    expect(events).toHaveLength(2);
  });
});
