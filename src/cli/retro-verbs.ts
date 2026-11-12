import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  Findings,
  RetroRecordResult,
  RetroRunResult,
} from "../core/domain/retro.ts";
import { retroRecord } from "../core/retro/record.ts";
import { retroRun } from "../core/retro/run.ts";
import { codeHostFor } from "./code-host.ts";
import { PodError, exitFor, schemaError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { Generation, quote, withOrca } from "./run-verbs.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

const RunArg = z.string().regex(/^run:.+$/);

export const RetroRunInput = z.strictObject({
  args: z.tuple([RunArg]),
  seat: z.string().min(1),
  generation: Generation,
  "op-key": z.string().min(1).optional(),
});
type RetroRunInput = z.infer<typeof RetroRunInput>;

export const RetroRunOutput = RetroRunResult;

export async function retroRunVerb(
  input: RetroRunInput,
): Promise<RetroRunResult> {
  const [runArg] = input.args;
  const command = [
    "pod",
    "retro",
    runArg,
    "--seat",
    input.seat,
    "--generation",
    input.generation,
  ]
    .map(quote)
    .join(" ");
  const { result } = await withOrca(async ({ db, orca, log, host }) =>
    retroRun(db, orca, log, {
      run: runArg.slice("run:".length),
      seat: input.seat,
      generation: Number(input.generation),
      attempt: input["op-key"] ?? "1",
      host: host.hostId,
      capacity: host.capacity,
      codeHost: codeHostFor(),
      command,
      now: () => new Date(),
    }),
  );
  return result;
}

export const RetroRecordInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  run: z.string().min(1),
});
type RetroRecordInput = z.infer<typeof RetroRecordInput>;

export const RetroRecordOutput = RetroRecordResult.extend({
  op_key: z.string(),
});
type RetroRecordOutput = z.infer<typeof RetroRecordOutput>;

export function retroMeta(output: { op_key: string }) {
  return { opKey: output.op_key };
}

export async function retroRecordVerb(
  input: RetroRecordInput,
): Promise<RetroRecordOutput> {
  const [path] = input.args;
  const findings = Findings.safeParse(parseYaml(readText(path), path));
  if (!findings.success)
    throw schemaError(
      `${path} fails the retro findings schema`,
      issuesOf(findings.error),
    );
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const outcome = await retroRecord(connection.db, {
      run: input.run.replace(/^run:/u, ""),
      findings: findings.data,
      host: host.hostId,
      now: () => new Date(),
    });
    if (!outcome.ok) {
      const { code, message, nextSteps } = outcome.refusal;
      throw new PodError(code, exitFor(code), message, nextSteps);
    }
    return { ...outcome.result, op_key: outcome.opKey };
  } finally {
    await connection.close();
  }
}
