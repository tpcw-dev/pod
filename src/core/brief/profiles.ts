import { singleActive } from "../config/active.ts";
import { activeProfile } from "../config/policy.ts";
import type { BriefTree } from "../domain/brief.ts";
import type { Repo } from "../ports/db.ts";

export const globalProject = "global";

export interface ProjectProfile {
  project: string;
  profile: string | null;
  policy: string | null;
  line: string;
}

export async function projectProfiles(
  repo: Repo,
  tree: BriefTree,
): Promise<ProjectProfile[]> {
  const named = new Set(await repo.activeScopeRefs("policy", "project"));
  for (const story of tree.stories)
    for (const run of story.runs)
      if (run.snapshot?.project != null) named.add(run.snapshot.project);
  const rows: ProjectProfile[] = [];
  for (const project of [globalProject, ...[...named].sort()]) {
    const policy =
      project === globalProject
        ? await singleActive(repo, "policy", "global", "")
        : await singleActive(repo, "policy", "project", project);
    const profile = policy === null ? null : activeProfile(policy.value);
    const ref = policy === null ? null : `${policy.name}@${policy.rev}`;
    rows.push({
      project,
      profile,
      policy: ref,
      line: `${project}: ${profile ?? "none"} (policy ${ref ?? "none"})`,
    });
  }
  return rows;
}
