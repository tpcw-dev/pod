import { singleActive } from "../config/active.ts";
import { usageLimits } from "../config/limits.ts";
import type { Pace } from "../domain/usage.ts";
import type { Repo } from "../ports/db.ts";
import { noHeadroom, worstWindow } from "../usage/pace.ts";
import type { ResetInForce } from "./overrides.ts";

export type UsageState = "available" | "held" | "unknown" | "reset";

export interface UsageGate {
  provider: string;
  state: UsageState;
  value: string | null;
  pace: Pace | null;
  window: string | null;
  observation_id: number | null;
}

export async function usageGates(
  repo: Repo,
  providers: readonly string[],
  resets: readonly ResetInForce[],
  now: Date,
): Promise<UsageGate[]> {
  const policy = await singleActive(repo, "policy", "global", "");
  const limits = usageLimits(policy?.value);
  const windows = await repo.latestUsageWindows(providers);
  const marked = new Set(resets.map((each) => each.harness));
  return [...providers].sort().map((provider) => {
    const { row, headroom } = worstWindow(
      windows.filter((each) => each.provider === provider),
      limits,
      now,
    );
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
    return {
      provider,
      state,
      ...read,
      window: row?.window ?? null,
      observation_id: row?.id ?? null,
    };
  });
}

export function observationIds(gates: readonly UsageGate[]): number[] {
  return gates
    .flatMap((gate) =>
      gate.observation_id === null ? [] : [gate.observation_id],
    )
    .sort((a, b) => a - b);
}
