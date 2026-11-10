import type { Repo } from "../ports/db.ts";
import { isMethod, ProcessValue } from "./schema.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function stepMethod(
  db: Repo,
  runId: string,
  stepId: string,
): Promise<string | null> {
  const snapshot = await db.getSnapshot(runId);
  if (snapshot === null) return null;
  if (snapshot.profile !== null) {
    const policy = await db.getRevision(snapshot.policy_revision_id);
    const profile = record(record(policy?.value)["profiles"])[snapshot.profile];
    const override = record(record(profile)["method"])[stepId];
    if (isMethod(override)) return override;
  }
  const process = await db.getRevision(snapshot.process_revision_id);
  const parsed = ProcessValue.safeParse(process?.value);
  if (!parsed.success) return null;
  return parsed.data.steps.find((step) => step.id === stepId)?.method ?? null;
}

export function withMethod(text: string, method: string | null): string {
  return method === null ? text : `${text}\n\nMethod: ${method}`;
}
