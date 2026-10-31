import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import type { OrcaPort } from "../../src/core/ports/orca.ts";
import { runCli } from "../db/helpers.ts";
import { recording, type Scenario } from "./tracker-scenario.ts";

const dir = "test/replay/gate-scenario";

export const recordTimeout = recording ? 3_600_000 : undefined;

function policyFile(): string {
  const path = join(dir, "policy.yaml");
  if (!recording) return path;
  const keeper = process.env["POD_RECORD_KEEPER_ACCOUNT"] ?? "";
  if (keeper === "")
    throw new Error("recording needs POD_RECORD_KEEPER_ACCOUNT");
  const policy = parse(readFileSync(path, "utf8")) as {
    value: { principals: { human: { tracker_account: string } } };
  };
  policy.value.principals.human.tracker_account = keeper;
  const out = join(mkdtempSync(join(tmpdir(), "pod-gate-policy-")), "p.yaml");
  writeFileSync(out, stringify(policy));
  return out;
}

export function applyGateConfig(gate: "review" | "hqa"): void {
  for (const file of [
    policyFile(),
    join(dir, "crew.yaml"),
    join(dir, `process-${gate}.yaml`),
  ]) {
    const applied = runCli([
      "config",
      "apply",
      file,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(applied.status, file).toBe(0);
  }
}

export async function waitForJerry(step: string): Promise<void> {
  if (!recording) return;
  const gateDir = process.env["POD_RECORD_GATE_DIR"] ?? "";
  if (gateDir === "") throw new Error("recording needs POD_RECORD_GATE_DIR");
  const marker = join(gateDir, step);
  process.stderr.write(`waiting for ${marker}\n`);
  while (!existsSync(marker))
    await new Promise((done) => setTimeout(done, 5000));
}

export function bypassFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "pod-gate-bypass-")), "b.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ host: "rec", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
  );
  return path;
}

export function hqa(
  conn: Connection,
  orca: OrcaPort,
  { tracker, log, story }: Scenario,
  bypassPath: string,
) {
  return recordHqa(conn.db, orca, tracker, log, {
    story,
    generation: 1,
    host: "rec",
    hostName: "rec",
    bypassPath,
    command: `pod hqa record story:${story.external_id} --generation 1`,
    now: () => new Date(),
  });
}

export async function receiptRows(conn: Connection) {
  return conn.sql<
    {
      id: number;
      gate_id: string;
      sync_state: string;
      deployed_revision: string | null;
    }[]
  >`select id, gate_id, sync_state, deployed_revision from ledger.gate_receipt order by id`;
}
