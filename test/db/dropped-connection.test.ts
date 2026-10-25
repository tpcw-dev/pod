import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { applyConfig, deriveOpKey } from "../../src/core/config/apply.ts";
import { revisionId } from "../../src/core/config/canonical-json.ts";
import type { Db } from "../../src/core/ports/db.ts";
import { envelope } from "./fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

function signal(): { wait: Promise<void>; fire: () => void } {
  let fire = (): void => {};
  const wait = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { wait, fire };
}

describeDb("dropped connection", () => {
  let victim: Connection;
  let killer: Connection;

  beforeAll(async () => {
    await resetDb();
    victim = openDb();
    killer = openDb();
  });
  afterAll(async () => {
    await victim.close();
    await killer.close();
  });

  test("a terminated apply leaves no partial row", async () => {
    const paused = signal();
    const never = new Promise<never>(() => {});
    const db: Db = {
      ...victim.db,
      transaction: (work) =>
        victim.db.transaction((tx) =>
          work({
            ...tx,
            appendEvent() {
              paused.fire();
              return never;
            },
          }),
        ),
    };
    const e = envelope("process", "dropped", { steps: ["a"] });
    const apply = applyConfig(db, {
      envelope: e,
      actor: "operator",
      reason: "",
      now: new Date(),
      activate: { expected: null, opKey: null, host: "local" },
    });
    const settled = apply.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await paused.wait;
    const open = await killer.sql<{ pid: number }[]>`
      select pid from pg_stat_activity
      where state = 'idle in transaction' and pid <> pg_backend_pid() and datname = current_database()`;
    expect(open).toHaveLength(1);
    const terminated = await killer.sql`
      select pg_terminate_backend(${open[0]?.pid ?? 0}) as terminated`;
    expect(terminated).toEqual([{ terminated: true }]);

    expect(await settled).toMatchObject({ code: "CONNECTION_CLOSED" });
    const id = revisionId(e);
    const opKey = deriveOpKey(e, null, id);
    expect(
      await killer.sql`select 1 from config.revision where id = ${id}`,
    ).toHaveLength(0);
    expect(
      await killer.sql`select 1 from config.activation where name = 'dropped'`,
    ).toHaveLength(0);
    expect(
      await killer.sql`select 1 from ledger.operation where op_key = ${opKey}`,
    ).toHaveLength(0);
    expect(
      await killer.sql`select 1 from ledger.event where op_key = ${opKey}`,
    ).toHaveLength(0);
  });
});
