import { z } from "zod";
import type { RevisionEnvelope } from "../domain/config.ts";
import type { Refusal } from "../domain/outcome.ts";
import type { Repo } from "../ports/db.ts";

const Minutes = z.int().positive();

const ScheduleValue = z.strictObject({
  tick_minutes: Minutes,
  hold_minutes: Minutes,
});
export type ScheduleValue = z.infer<typeof ScheduleValue>;

export const scheduleName = "default";

function invalid(message: string, path: string): Refusal {
  return { code: "schema_invalid", message, nextSteps: [path] };
}

export function scheduleRefusal(envelope: RevisionEnvelope): Refusal | null {
  if (envelope.scope !== "host")
    return invalid(
      `a schedule Revision has scope host, not ${envelope.scope}`,
      "scope",
    );
  if (envelope.name !== scheduleName)
    return invalid(
      `a schedule Revision is named ${scheduleName}, not ${envelope.name}`,
      "name",
    );
  const parsed = ScheduleValue.safeParse(envelope.value);
  if (parsed.success) return null;
  const [issue] = parsed.error.issues;
  const path =
    issue?.code === "unrecognized_keys"
      ? [...issue.path, ...issue.keys]
      : (issue?.path ?? []);
  return invalid(
    `schedule value fails its schema: ${issue?.message ?? "invalid"}`,
    path.join("."),
  );
}

export interface ActiveSchedule {
  revision_id: string;
  value: ScheduleValue;
}

export async function activeSchedule(
  repo: Repo,
  host: string,
): Promise<ActiveSchedule | null> {
  const [active] = await repo.listActivations("schedule", "host", host);
  const revision =
    active === undefined ? null : await repo.getRevision(active.revision_id);
  const value = ScheduleValue.safeParse(revision?.value).data;
  return revision === null || value === undefined
    ? null
    : { revision_id: revision.id, value };
}

export function scheduleMissing(host: string): Refusal {
  return {
    code: "config_missing",
    message: `host ${host} has no active schedule Revision`,
    nextSteps: [
      `pod config apply specs/schedule/default.yaml --ticket K, with scope_ref ${host}`,
      `then a person runs pod config activate schedule.${scheduleName}@REV --scope host:${host} --expected-revision none`,
    ],
  };
}
