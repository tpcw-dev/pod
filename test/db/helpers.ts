import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, inject } from "vitest";
import {
  connect,
  type Connection,
} from "../../src/adapters/postgres/connection.ts";
import { migrate } from "../../src/adapters/postgres/migrate.ts";
import { migrationsFolder } from "../../src/cli/db-verbs.ts";

export const required = process.env["POD_DB_REQUIRED"] === "1";

const url = inject("dbUrl");

export const describeDb = describe;

export function dbUrl(): string {
  return url;
}

const connectAttempts = 3;
const connectRetryDelayMs = 1_000;

function errorCode(error: unknown): unknown {
  return error instanceof Object && "code" in error ? error.code : undefined;
}

function isTimeout(error: unknown): boolean {
  return (
    errorCode(error) === "ETIMEDOUT" ||
    (error instanceof Error && errorCode(error.cause) === "ETIMEDOUT")
  );
}

export async function withConnectRetry<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  for (let attempts = 1; ; attempts += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (attempts === connectAttempts || !isTimeout(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, connectRetryDelayMs));
    }
  }
}

export async function resetDb(): Promise<void> {
  await withConnectRetry(async () => {
    const connection = connect(dbUrl());
    try {
      await connection.sql`set client_min_messages = warning`;
      await connection.sql`drop schema if exists config, ledger, drizzle cascade`;
    } finally {
      await connection.close();
    }
  });
  const result = await migrate(dbUrl(), migrationsFolder());
  if (result.kind !== "ok")
    throw new Error("migrate refused on a fresh database");
}

export function openDb(): Connection {
  return connect(dbUrl());
}

export const podHome = mkdtempSync(join(tmpdir(), "pod-home-"));

export interface CliResult {
  status: number | null;
  json: {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; nextSteps: string[] };
    meta?: Record<string, unknown>;
  };
}

export function runCli(
  args: string[],
  env: Record<string, string> = {},
): CliResult {
  const result = spawnSync(
    "node_modules/.bin/tsx",
    ["src/cli/index.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, POD_DB_URL: dbUrl(), POD_HOME: podHome, ...env },
    },
  );
  return {
    status: result.status,
    json: JSON.parse(result.stdout) as CliResult["json"],
  };
}

export async function clearDb(connection: Connection): Promise<void> {
  const tables = await connection.sql<{ name: string }[]>`
    select format('%I.%I', schemaname, tablename) as name
    from pg_tables where schemaname in ('config', 'ledger')`;
  await connection.sql.unsafe(
    `truncate ${tables.map((table) => table.name).join(", ")} cascade`,
  );
}
