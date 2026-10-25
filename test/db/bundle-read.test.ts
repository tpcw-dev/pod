import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { ActivationKey, Revision } from "../../src/core/domain/config.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

const keys: ActivationKey[] = [
  { scope: "global", scope_ref: "", kind: "crew", name: "crew" },
  { scope: "global", scope_ref: "", kind: "policy", name: "policy" },
];

describeDb("bundle read", () => {
  let one: Connection;
  let two: Connection;
  const old: Revision[] = [];
  const next: Revision[] = [];

  beforeAll(async () => {
    await resetDb();
    one = openDb();
    two = openDb();
    for (const key of keys) {
      const before = await storeRevision(
        one.db,
        envelope(key.kind, key.name, { v: 1 }),
      );
      const after = await storeRevision(
        one.db,
        envelope(key.kind, key.name, { v: 2 }),
      );
      old.push(before);
      next.push(after);
      await one.db.activate({
        ...key,
        expected: null,
        revision_id: before.id,
        bundle_id: null,
        activated_by: "operator",
        activated_at: new Date(),
      });
    }
  });
  afterAll(async () => {
    await one.close();
    await two.close();
  });

  async function readBoth(): Promise<
    { revision_id: string; bundle_id: string | null }[]
  > {
    return two.sql<{ revision_id: string; bundle_id: string | null }[]>`
      select revision_id, bundle_id from config.activation where kind in ('crew', 'policy') order by kind`;
  }

  test("a reader sees neither row of an open bundle, then both", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWritten = (): void => {};
    const written = new Promise<void>((resolve) => {
      firstWritten = resolve;
    });
    const bundle = one.db.transaction(async (tx) => {
      for (const [index, key] of keys.entries()) {
        const result = await tx.activate({
          ...key,
          expected: old[index]?.id ?? null,
          revision_id: next[index]?.id ?? "",
          bundle_id: "bundle-1",
          activated_by: "operator",
          activated_at: new Date(),
        });
        expect(result.ok).toBe(true);
        if (index === 0) {
          firstWritten();
          await held;
        }
      }
    });
    await written;
    expect(await readBoth()).toEqual(
      old.map((r) => ({ revision_id: r.id, bundle_id: null })),
    );
    release();
    await bundle;
    expect(await readBoth()).toEqual(
      next.map((r) => ({ revision_id: r.id, bundle_id: "bundle-1" })),
    );
  });

  test("activateBundle refuses the whole bundle on one stale row", async () => {
    const result = await one.db.activateBundle(
      keys.map((key, index) => ({
        ...key,
        expected: index === 0 ? (next[0]?.id ?? null) : (old[1]?.id ?? null),
        revision_id: old[index]?.id ?? "",
        activated_by: "operator",
        activated_at: new Date(),
      })),
      "bundle-2",
    );
    expect(result).toEqual({ ok: false, index: 1, active: next[1]?.id });
    expect(await readBoth()).toEqual(
      next.map((r) => ({ revision_id: r.id, bundle_id: "bundle-1" })),
    );
  });
});
