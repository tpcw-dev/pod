import { activeHostRevision, capacityMissing } from "../config/host.ts";
import { projectValue, type ProjectValue } from "../config/project.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import type { Repo } from "../ports/db.ts";
import { hostDay, isTimezone } from "./clock.ts";
import { planEvents, type PlanEvent } from "./overrides.ts";

export interface PlanHost {
  ok: true;
  host: string;
  day: string;
  timezone: string;
  revision_id: string;
  slots: { default: number; max: number };
  reserved: Record<string, number>;
  projects: string[];
  events: PlanEvent[];
}

function timezoneMissing(host: string, revision: string): Refused {
  return refuse(
    "config_missing",
    `host ${host}'s active host Revision ${revision} has no valid timezone`,
    [
      `pod config set host.${host} timezone=<IANA name> --scope host:${host} --reason R --ticket K`,
      `then a person runs pod config activate host.${host}@REV --scope host:${host} --expected-revision ${revision}`,
    ],
  );
}

export async function planHost(
  repo: Repo,
  host: string,
  now: Date,
): Promise<PlanHost | Refused> {
  const active = await activeHostRevision(repo, host);
  if (active === null) return { ok: false, refusal: capacityMissing(host) };
  const { timezone, slots, reserved, projects } = active.value;
  if (timezone === undefined || !isTimezone(timezone))
    return timezoneMissing(host, active.revision_id);
  return {
    ok: true,
    host,
    day: hostDay(now, timezone),
    timezone,
    revision_id: active.revision_id,
    slots,
    reserved,
    projects,
    events: planEvents(await repo.eventsWith("plan", { host })),
  };
}

export interface SeatedProject {
  name: string;
  revision_id: string;
  value: ProjectValue | null;
}

async function seatedElsewhere(repo: Repo, host: string): Promise<Set<string>> {
  const seated = new Set<string>();
  for (const ref of await repo.activeScopeRefs("host", "host")) {
    if (ref === host) continue;
    for (const name of (await activeHostRevision(repo, ref))?.value.projects ??
      [])
      seated.add(name);
  }
  return seated;
}

export async function seatedProjects(
  repo: Repo,
  context: PlanHost,
): Promise<SeatedProject[]> {
  const anyProject = context.projects.includes("*");
  const elsewhere = anyProject
    ? await seatedElsewhere(repo, context.host)
    : new Set<string>();
  const seated: SeatedProject[] = [];
  for (const each of await repo.listActivations("project", "global", "")) {
    const named = anyProject
      ? !elsewhere.has(each.name)
      : context.projects.includes(each.name);
    if (!named) continue;
    const revision = await repo.getRevision(each.revision_id);
    seated.push({
      name: each.name,
      revision_id: each.revision_id,
      value: projectValue(revision?.value),
    });
  }
  return seated.sort((a, b) => a.name.localeCompare(b.name));
}
