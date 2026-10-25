import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { migrate } from "../adapters/postgres/migrate.ts";
import { PodError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";

export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const folder = join(dir, "db", "migrations");
    if (existsSync(join(folder, "meta", "_journal.json"))) return folder;
    const up = dirname(dir);
    if (up === dir)
      throw new Error("db/migrations/meta/_journal.json not found");
    dir = up;
  }
}

export const DbMigrateInput = z.strictObject({ args: z.tuple([]) });
export const DbMigrateOutput = z.object({ journal: z.int(), applied: z.int() });

export async function dbMigrate(): Promise<z.infer<typeof DbMigrateOutput>> {
  const url = databaseUrl(readHostProfile());
  const result = await migrate(url, migrationsFolder());
  if (result.kind === "journal_mismatch")
    throw new PodError(
      "journal_mismatch",
      3,
      "the applied-migrations table holds migrations the journal lacks",
      [
        ...result.unknown.map((hash) => `unknown applied migration ${hash}`),
        "git log -- db/migrations",
      ],
    );
  return { journal: result.journal, applied: result.applied };
}
