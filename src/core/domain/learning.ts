import { z } from "zod";

export const Area = z.enum(["product", "design", "impl", "process"]);
export type Area = z.infer<typeof Area>;

export const Adoption = z.enum([
  "new",
  "proposed",
  "adopted",
  "rejected",
  "done",
]);
export type Adoption = z.infer<typeof Adoption>;

export const Reporter = z.enum(["lead", "retro", "healthcheck"]);
export type Reporter = z.infer<typeof Reporter>;

const nonEmpty = z.string().min(1);

export const LearningFile = z.strictObject({
  source_story: nonEmpty,
  evidence_refs: z.array(nonEmpty).min(1),
  text: nonEmpty,
  adoption: Adoption.default("new"),
  expected: nonEmpty.optional(),
});
export type LearningFile = z.infer<typeof LearningFile>;

export interface NewLearning {
  source_story: string;
  evidence_refs: string[];
  text: string;
  adoption: Adoption;
  area: Area;
  project_id: string | null;
  kind: string;
  expected: string | null;
  theme: string | null;
  action_story: string | null;
  created_at: Date;
  adoption_at: Date;
}

export interface Learning extends NewLearning {
  id: number;
  occurrences: number;
}

export interface NewOccurrence {
  learning_id: number;
  story: string;
  occurred_on: string;
  reporter: Reporter;
  wording: string;
  evidence_id: string;
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
  kind: string;
  expected: string | null;
  evidence_refs: string[];
  reporter: Reporter;
  repeat_of: number | null;
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


const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be a YYYY-MM-DD date")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "must be a valid date");

export const ImportOccurrence = z.strictObject({
  story: nonEmpty,
  occurred_on: isoDate,
  reporter: Reporter,
  wording: nonEmpty,
  evidence_id: nonEmpty,
});
export type ImportOccurrence = z.infer<typeof ImportOccurrence>;

export const ImportRow = z
  .strictObject({
    source_ref: nonEmpty,
    kind: nonEmpty,
    area: Area,
    text: nonEmpty,
    expected: nonEmpty.optional(),
    adoption: Adoption,
    theme: nonEmpty.optional(),
    action_story: nonEmpty.optional(),
    project: nonEmpty.optional(),
    occurrences: z.array(ImportOccurrence).min(1),
  })
  .superRefine((row, ctx) => {
    const seen = new Set<string>();
    row.occurrences.forEach((occurrence, index) => {
      if (seen.has(occurrence.evidence_id))
        ctx.addIssue({
          code: "custom",
          path: ["occurrences", index, "evidence_id"],
          message: `repeats ${occurrence.evidence_id}`,
        });
      seen.add(occurrence.evidence_id);
    });
  });
export type ImportRow = z.infer<typeof ImportRow>;

export const ImportFile = z
  .array(ImportRow)
  .min(1)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.source_ref))
        ctx.addIssue({
          code: "custom",
          path: [index, "source_ref"],
          message: `repeats ${row.source_ref}`,
        });
      seen.add(row.source_ref);
    });
  });

export function acceptImportFile(
  value: unknown,
): { ok: true; rows: ImportRow[] } | { ok: false; issues: string[] } {
  const parsed = ImportFile.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.flatMap((issue) => {
        const path = `rows${issue.path
          .map((part) =>
            typeof part === "number" ? `[${part}]` : `.${String(part)}`,
          )
          .join("")}`;
        return issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => `${path}.${key}: unknown key`)
          : [`${path}: ${issue.message}`];
      }),
    };
  return { ok: true, rows: parsed.data };
}
