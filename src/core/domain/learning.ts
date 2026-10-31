import { z } from "zod";

export const Area = z.enum(["product", "design", "impl", "process"]);
export type Area = z.infer<typeof Area>;

export const Adoption = z.enum(["new", "adopted", "rejected"]);
export type Adoption = z.infer<typeof Adoption>;

const nonEmpty = z.string().min(1);

export const LearningFile = z.strictObject({
  source_story: nonEmpty,
  evidence_refs: z.array(nonEmpty).min(1),
  text: nonEmpty,
  adoption: Adoption.default("new"),
});
export type LearningFile = z.infer<typeof LearningFile>;

export interface Learning {
  id: number;
  source_story: string;
  evidence_refs: string[];
  text: string;
  adoption: Adoption;
  area: Area;
  project_id: string | null;
  created_at: Date;
}

export interface NewLearning {
  source_story: string;
  evidence_refs: string[];
  text: string;
  adoption: Adoption;
  area: Area;
  project_id: string | null;
  created_at: Date;
}

export interface LearningFilter {
  story?: string;
  adoption?: Adoption;
  text?: string;
  area?: Area;
  project?: string;
}

export interface LearningIdentity {
  source_story: string;
  text: string;
  area: string;
  project_id: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueText(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

export function acceptLearningFile(
  value: unknown,
): { ok: true; file: LearningFile } | { ok: false; issues: string[] } {
  if (!isRecord(value))
    return { ok: false, issues: ["(root): expected an object"] };
  const issues: string[] = [];
  if ("area" in value)
    issues.push("area: pass --area; the file does not carry area");
  if ("project" in value)
    issues.push("project: pass --project; the file does not carry project");
  if (issues.length > 0) return { ok: false, issues };
  const parsed = LearningFile.safeParse(value);
  if (!parsed.success) return { ok: false, issues: issueText(parsed.error) };
  return { ok: true, file: parsed.data };
}

