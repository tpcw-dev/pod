import type { Held, Ranked } from "../domain/plan.ts";
import type { InForce } from "./overrides.ts";

export interface RankInput {
  host: string;
  day: string;
  slots: number;
  overrides: InForce;
}

export interface Ranking {
  ranked: Ranked[];
  held: Held[];
}

export function rankPlan(input: RankInput): Ranking {
  return {
    ranked: [],
    held: input.overrides.holds.map(({ key, reason }) => ({ key, reason })),
  };
}
