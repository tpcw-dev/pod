import type { Repo } from "../ports/db.ts";
import { singleActive } from "./active.ts";
import { servicesOf } from "./policy.ts";

export interface ServiceKinds {
  trackerKind: string;
  estimateScale: string;
  docsKind: string;
}

export async function serviceKinds(repo: Repo): Promise<ServiceKinds> {
  const policy = await singleActive(repo, "policy", "global", "");
  const { tracker, docs } = servicesOf(policy?.value);
  return {
    trackerKind: tracker?.kind ?? "linear",
    estimateScale: tracker?.estimate_scale ?? "fibonacci",
    docsKind: docs?.kind ?? "notion",
  };
}
