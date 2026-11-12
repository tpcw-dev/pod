import { readFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { singleActive } from "../core/config/active.ts";
import { usageLimits } from "../core/config/limits.ts";
import { parseUsage } from "../core/domain/usage.ts";
import { recordUsage } from "../core/usage/record.ts";
import { schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { readText } from "./yaml-file.ts";

export const UsageRecordInput = z.strictObject({
  args: z.tuple([z.string()]),
});
type UsageRecordInput = z.infer<typeof UsageRecordInput>;

const Pace = z.enum(["spend", "ok", "avoid"]).nullable();

export const UsageRecordOutput = z.object({
  units: z.number(),
  duplicates: z.number(),
  sessions: z.array(
    z.object({
      runtime: z.string(),
      session_id: z.string(),
      attribution: z.enum(["locator", "path", "unattributed"]).nullable(),
      dispatch_id: z.string().nullable(),
      run_id: z.string().nullable(),
      first_at: z.string().nullable(),
      through: z.string().nullable(),
      rows: z.number(),
      outcome: z.enum(["written", "replayed", "nothing_new"]),
    }),
  ),
  windows: z.array(
    z.object({
      runtime: z.string(),
      window: z.string(),
      observed_at: z.string(),
      pace: Pace,
      outcome: z.enum(["written", "replayed"]),
    }),
  ),
});
type UsageRecordOutput = z.infer<typeof UsageRecordOutput>;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError("cannot read stdin", [reason]);
  }
}

export async function usageRecordVerb(
  input: UsageRecordInput,
): Promise<UsageRecordOutput> {
  const [path] = input.args;
  const parsed = parseUsage(path === "-" ? readStdin() : readText(path));
  if (!parsed.ok)
    throw schemaError(`${path} fails the usage record format`, parsed.issues);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const policy = await singleActive(connection.db, "policy", "global", "");
    return await recordUsage(connection.db, {
      usage: parsed.input,
      limits: usageLimits(policy?.value),
      host: host.hostId,
      now: () => new Date(),
    });
  } finally {
    await connection.close();
  }
}
