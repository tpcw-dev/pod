import { z } from "zod";
import type { RevisionEnvelope } from "../domain/config.ts";
import type { Refusal } from "../domain/outcome.ts";
import { sessionToken } from "../dispatch/transcript.ts";
import type { Repo } from "../ports/db.ts";

const anyProject = "*";

const Name = z.string().min(1);
const Size = z.string().regex(/^[1-9][0-9]*[KMGT]$/, "needs a size such as 4G");
const Count = z.int().nonnegative();

function unique(list: readonly string[]): boolean {
  return new Set(list).size === list.length;
}

const Names = z.array(Name).refine(unique, "names one twice");

const HostValue = z.strictObject({
  driver: Name,
  hostnames: Names.min(1),
  manager: z.boolean(),
  decision_seat: z.boolean().optional(),
  slots: z.strictObject({ default: Count, max: Count }),
  reserved: z.record(Name, z.int().positive()),
  projects: Names.refine(
    (list) => !list.includes(anyProject) || list.length === 1,
    `"${anyProject}" stands alone`,
  ),
  harnesses: Names.min(1).optional(),
  transcripts: z
    .record(
      Name,
      z
        .string()
        .refine(
          (template) => template.includes(sessionToken),
          `names ${sessionToken}`,
        ),
    )
    .optional(),
  notion_harnesses: Names.optional(),
  notion: z.boolean().optional(),
  scheduler: z.enum(["orca", "nohup"]).optional(),
  limits: z
    .strictObject({
      min_available_mb: Count.optional(),
      max_swap_used_pct: Count.max(100).optional(),
      crew_memory_max: Size.optional(),
      crew_swap_max: Size.optional(),
    })
    .optional(),
});
type HostValue = z.infer<typeof HostValue>;

function invalid(message: string, path: string): Refusal {
  return { code: "schema_invalid", message, nextSteps: [path] };
}

function crossFieldProblem(host: HostValue): Refusal | null {
  const { slots } = host;
  if (slots.default > slots.max)
    return invalid(
      `slots.default ${slots.default} is above slots.max ${slots.max}`,
      "slots.default",
    );
  const held = Object.values(host.reserved).reduce((sum, n) => sum + n, 0);
  if (held > slots.max)
    return invalid(
      `reserved holds ${held} slots, more than slots.max ${slots.max}`,
      "reserved",
    );
  if (host.decision_seat === true && !host.manager)
    return invalid("decision_seat needs manager true", "decision_seat");
  const outside = (host.notion_harnesses ?? []).find(
    (each) => host.harnesses !== undefined && !host.harnesses.includes(each),
  );
  if (outside !== undefined)
    return invalid(
      `notion_harnesses names ${outside}, which is not in harnesses`,
      "notion_harnesses",
    );
  return null;
}

function checkHost(
  value: unknown,
): { host: HostValue; refusal: null } | { host: null; refusal: Refusal } {
  const parsed = HostValue.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path =
      issue?.code === "unrecognized_keys"
        ? [...issue.path, ...issue.keys]
        : (issue?.path ?? []);
    return {
      host: null,
      refusal: invalid(
        `host value fails its schema: ${issue?.message ?? "invalid"}`,
        path.join("."),
      ),
    };
  }
  const refusal = crossFieldProblem(parsed.data);
  return refusal === null
    ? { host: parsed.data, refusal: null }
    : { host: null, refusal };
}

export function validateHost(value: unknown): Refusal | null {
  return checkHost(value).refusal;
}

async function seatedElsewhere(
  repo: Repo,
  self: string,
  projects: readonly string[],
): Promise<Refusal | null> {
  for (const ref of await repo.activeScopeRefs("host", "host")) {
    if (ref === self) continue;
    const active = await repo.getActivation({
      scope: "host",
      scope_ref: ref,
      kind: "host",
      name: ref,
    });
    const revision =
      active === null ? null : await repo.getRevision(active.revision_id);
    const seated = HostValue.safeParse(revision?.value).data?.projects ?? [];
    const taken = projects.find((project) => seated.includes(project));
    if (taken !== undefined)
      return invalid(
        `projects: "${taken}" is already seated on host ${ref}`,
        "projects",
      );
  }
  return null;
}

export async function hostRefusal(
  repo: Repo,
  envelope: RevisionEnvelope,
): Promise<Refusal | null> {
  if (envelope.scope !== "host" || envelope.scope_ref !== envelope.name)
    return invalid(
      `a host Revision has scope host and a scope_ref equal to its name ${envelope.name}`,
      "scope_ref",
    );
  const { host, refusal } = checkHost(envelope.value);
  if (host === null) return refusal;
  return seatedElsewhere(repo, envelope.name, host.projects);
}

async function activeHost(
  repo: Repo,
  host: string,
): Promise<HostValue | null> {
  const active = await repo.getActivation({
    scope: "host",
    scope_ref: host,
    kind: "host",
    name: host,
  });
  const revision =
    active === null ? null : await repo.getRevision(active.revision_id);
  return HostValue.safeParse(revision?.value).data ?? null;
}

export async function hostTranscripts(
  repo: Repo,
  host: string,
): Promise<Record<string, string>> {
  return (await activeHost(repo, host))?.transcripts ?? {};
}

export async function hostSlots(
  repo: Repo,
  hostId: string,
): Promise<number | null> {
  return (await activeHost(repo, hostId))?.slots.default ?? null;
}

export function capacityMissing(hostId: string): Refusal {
  return {
    code: "config_missing",
    message: `host ${hostId} has no active host Revision`,
    nextSteps: [
      `pod config apply specs/host/${hostId}.yaml --ticket K`,
      `then a person runs pod config activate host.${hostId}@REV --scope host:${hostId} --expected-revision none`,
    ],
  };
}
