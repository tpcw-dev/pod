import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../core/ports/db.ts";
import { makeDb } from "./repository.ts";

export interface Connection {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function connect(url: string): Connection {
  const sql = postgres(url, { onnotice: () => {} });
  return {
    db: makeDb(drizzle(sql)),
    sql,
    close: () => sql.end(),
  };
}
