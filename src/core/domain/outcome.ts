import { z } from "zod";

export const RefusalCode = z.enum([
  "schema_invalid",
  "selector_none",
  "selector_conflict",
  "revision_not_found",
  "owner_generation_stale",
  "duplicate_op",
  "drained",
  "task_not_ready",
  "quota_exhausted",
  "role_unfilled",
  "reviewer_not_independent",
  "launch_unknown",
  "release_refused",
  "failed",
]);
export type RefusalCode = z.infer<typeof RefusalCode>;

export interface Refusal {
  code: RefusalCode;
  message: string;
  nextSteps: string[];
}

export type Refused = { ok: false; refusal: Refusal };

export type Checked<T> = { ok: true; result: T; orca: string } | Refused;

export type Outcome<T> =
  | { ok: true; result: T; opKey: string; orca: string }
  | { ok: false; refusal: Refusal };

export function refuse(
  code: RefusalCode,
  message: string,
  nextSteps: string[],
): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message, nextSteps } };
}
