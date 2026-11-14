import { activeHostRevision, capacityMissing } from "../config/host.ts";
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
