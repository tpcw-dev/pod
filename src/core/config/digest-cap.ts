import { z } from "zod";
import type { Repo } from "../ports/db.ts";
import { singleActive } from "./active.ts";

export const defaultDigestCap = 3;

const PolicyLimits = z.looseObject({
  limits: z.looseObject({ digest_per_day: z.int().min(1).max(10) }),
});

function capOf(policyValue: unknown): number | undefined {
  return PolicyLimits.safeParse(policyValue).data?.limits.digest_per_day;
}

export async function digestCap(
  repo: Repo,
  project: string | null,
): Promise<number> {
  const global = await singleActive(repo, "policy", "global", "");
  const own =
    project === null
      ? undefined
      : capOf((await singleActive(repo, "policy", "project", project))?.value);
  return own ?? capOf(global?.value) ?? defaultDigestCap;
}
