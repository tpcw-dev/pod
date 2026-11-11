import { z } from "zod";
import type { RevisionEnvelope } from "../domain/config.ts";
import type { Refusal } from "../domain/outcome.ts";

const Name = z.string().min(1);

const ProjectValue = z.strictObject({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "needs owner/name"),
  category: z.enum(["Applications", "Quant", "Poker", "Meta"]),
  staging: z.boolean(),
  tracker: z.strictObject({ project_name: Name, project_id: Name }),
});
type ProjectValue = z.infer<typeof ProjectValue>;

function invalid(message: string, path: string): Refusal {
  return { code: "schema_invalid", message, nextSteps: [path] };
}

function checkProject(
  value: unknown,
):
  | { project: ProjectValue; refusal: null }
  | { project: null; refusal: Refusal } {
  const parsed = ProjectValue.safeParse(value);
  if (parsed.success) return { project: parsed.data, refusal: null };
  const [issue] = parsed.error.issues;
  const path =
    issue?.code === "unrecognized_keys"
      ? [...issue.path, ...issue.keys]
      : (issue?.path ?? []);
  return {
    project: null,
    refusal: invalid(
      `project value fails its schema: ${issue?.message ?? "invalid"}`,
      path.join("."),
    ),
  };
}

export function validateProject(value: unknown): Refusal | null {
  return checkProject(value).refusal;
}

export function projectRefusal(envelope: RevisionEnvelope): Refusal | null {
  if (envelope.scope !== "global")
    return invalid(
      `a project Revision has scope global, not ${envelope.scope}`,
      "scope",
    );
  const { project, refusal } = checkProject(envelope.value);
  if (project === null) return refusal;
  const repoName = project.repo.slice(project.repo.indexOf("/") + 1);
  return repoName === envelope.name
    ? null
    : invalid(
        `repo ${project.repo} names ${repoName}, not the project ${envelope.name}`,
        "repo",
      );
}
