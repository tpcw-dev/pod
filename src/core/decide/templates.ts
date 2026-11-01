import { z } from "zod";

export const templateFields = [
  "decider",
  "auditor",
  "round_open",
  "round_next",
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
] as const;

export type Placeholder = (typeof placeholders)[number];
export type Templates = Record<(typeof templateFields)[number], string>;

const pattern = /\{\{([a-z_]+)\}\}/g;

export const Templates = z.strictObject({
  decider: z.string().min(1),
  auditor: z.string().min(1),
  round_open: z.string().min(1),
  round_next: z.string().min(1),
});

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
  for (const key of Object.keys(record))
    if (!(templateFields as readonly string[]).includes(key))
      return {
        path: `value.${key}`,
        message: `value.${key} is not a decision template field`,
      };
  for (const field of templateFields) {
    const text = record[field];
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
