import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

const Journal = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});

export type MigrateResult =
  | { kind: "ok"; journal: number; applied: number }
  | { kind: "journal_mismatch"; unknown: string[] };

function journalHashes(folder: string): string[] {
  const journal = Journal.parse(
    JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")),
  );
  return journal.entries.map((entry) =>
    createHash("sha256")
      .update(readFileSync(join(folder, `${entry.tag}.sql`)))
      .digest("hex"),
  );
}

async function appliedHashes(sql: postgres.Sql): Promise<string[]> {
  const [found] = await sql<{ table: string | null }[]>`
    select to_regclass('drizzle.__drizzle_migrations')::text as table`;
  if (found?.table === null || found === undefined) return [];
  const rows = await sql<{ hash: string }[]>`
    select hash from drizzle.__drizzle_migrations order by id`;
  return rows.map((row) => row.hash);
}

export async function migrate(
  url: string,
  folder: string,
): Promise<MigrateResult> {
  const known = journalHashes(folder);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const before = await appliedHashes(sql);
    const unknown = before.filter((hash) => !known.includes(hash));
    if (unknown.length > 0) return { kind: "journal_mismatch", unknown };
    await drizzleMigrate(drizzle(sql), { migrationsFolder: folder });
    const after = await appliedHashes(sql);
    return {
      kind: "ok",
      journal: known.length,
      applied: after.length - before.length,
    };
  } finally {
    await sql.end();
  }
}
