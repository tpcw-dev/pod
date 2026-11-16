import { singleActive } from "../config/active.ts";
import { usageLimits } from "../config/limits.ts";
import type { Pace } from "../domain/usage.ts";
import type { Repo } from "../ports/db.ts";
import { readHeadroom } from "../usage/pace.ts";
import type { ResetInForce } from "./overrides.ts";

export type UsageState = "available" | "held" | "unknown" | "reset";

export interface UsageGate {
  provider: string;
  state: UsageState;
  value: string | null;
  pace: Pace | null;
  observation_id: number | null;
}

function noHeadroom(value: string, pace: Pace | null): boolean {
  return pace === "avoid" || Number(value) >= 100;
}

export async function usageGates(
  repo: Repo,
  providers: readonly string[],
  resets: readonly ResetInForce[],
  now: Date,
): Promise<UsageGate[]> {
  const policy = await singleActive(repo, "policy", "global", "");
  const limits = usageLimits(policy?.value);
  const latest = new Map(
    (await repo.latestUsageObservations(providers)).map((row) => [
      row.provider,
      row,
    ]),
  );
  const marked = new Set(resets.map((each) => each.harness));
  return [...providers].sort().map((provider) => {
    const row = latest.get(provider);
    const headroom = readHeadroom(row, limits, now);
    const read =
      headroom === "unknown"
        ? { value: null, pace: null }
        : { value: headroom.value, pace: headroom.pace };
    const state: UsageState = marked.has(provider)
      ? "reset"
      : read.value === null
        ? "unknown"
        : noHeadroom(read.value, read.pace)
          ? "held"
          : "available";
    return { provider, state, ...read, observation_id: row?.id ?? null };
  });
}

export function observationIds(gates: readonly UsageGate[]): number[] {
  return gates
    .flatMap((gate) =>
      gate.observation_id === null ? [] : [gate.observation_id],
    )
    .sort((a, b) => a - b);
}
