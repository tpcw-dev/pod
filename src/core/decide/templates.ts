import { z } from "zod";

export const templateFields = [
  "decider",
  "auditor",
  "round_open",
  "round_next",
] as const;

export const optionalTemplateFields = [
  "resume_summary",
  "evidence_request",
  "evidence",
  "coordinator_open",
] as const;

export const placeholders = [
  "question",
  "options",
  "manifest_id",
  "manifest",
  "round",
  "audit",
  "points_of_disagreement",
  "decision_id",
  "summary",
  "proposal",
  "citations",
  "story",
  "process",
  "run_id",
  "generation",
  "check",
  "view_path",
] as const;

export type Placeholder = (typeof placeholders)[number];

const pattern = /\{\{([a-z_]+)\}\}/g;

export const Templates = z.strictObject({
  decider: z.string().min(1),
  auditor: z.string().min(1),
  round_open: z.string().min(1),
  round_next: z.string().min(1),
  resume_summary: z.string().min(1).optional(),
  evidence_request: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
  coordinator_open: z.string().min(1).optional(),
});
export type Templates = z.infer<typeof Templates>;

export const fallbackTemplates: Record<
  (typeof optionalTemplateFields)[number],
  string
> = {
  resume_summary:
    "Decision {{decision_id}} resumes at round {{round}}.\n\nEarlier rounds:\n{{summary}}",
  evidence_request:
    "Decision {{decision_id}} round {{round}}. The auditor needs evidence.\n\nAudit: {{audit}}",
  evidence:
    "Decision {{decision_id}} round {{round}}. Audit this proposal against Evidence manifest {{manifest_id}}.\n\nProposal: {{proposal}}\nCitations: {{citations}}\n{{manifest}}",
  coordinator_open:
    "You coordinate Pod Run {{run_id}} for {{story}} under {{process}} at owner generation {{generation}}. Start with:\n\n{{check}}\n\nRestore view: {{view_path}}",
};

export function templateOf(
  templates: Templates | null,
  field: (typeof optionalTemplateFields)[number],
): string {
  return templates?.[field] ?? fallbackTemplates[field];
}

export function renderTemplate(
  template: string,
  fields: Partial<Record<Placeholder, string>>,
): string {
  return template.replace(
    pattern,
    (_, name: string) => fields[name as Placeholder] ?? "",
  );
}

export function validateDecisionTemplates(
  value: unknown,
): { path: string; message: string } | null {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const known: readonly string[] = [
    ...templateFields,
    ...optionalTemplateFields,
  ];
  for (const key of Object.keys(record))
    if (!known.includes(key))
      return {
        path: `value.${key}`,
        message: `value.${key} is not a decision template field`,
      };
  for (const field of known) {
    const text = record[field];
    const optional = (optionalTemplateFields as readonly string[]).includes(
      field,
    );
    if (optional && text === undefined) continue;
    if (typeof text !== "string" || text === "")
      return {
        path: `value.${field}`,
        message: `value.${field} must be a non-empty string`,
      };
    for (const [, name] of text.matchAll(pattern))
      if (!(placeholders as readonly string[]).includes(name ?? ""))
        return {
          path: `value.${field}`,
          message: `value.${field} uses unknown placeholder {{${name ?? ""}}}`,
        };
  }
  return null;
}

export function optionsText(options: readonly string[]): string {
  return options.map((option) => `- ${option}`).join("\n");
}
