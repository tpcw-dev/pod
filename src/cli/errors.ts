export type ErrorCode =
  | "usage"
  | "schema_invalid"
  | "revision_conflict"
  | "revision_not_found"
  | "duplicate_op"
  | "journal_mismatch"
  | "story_not_found"
  | "selector_none"
  | "selector_conflict"
  | "selector_many"
  | "owner_generation_stale"
  | "task_not_ready"
  | "quota_exhausted"
  | "role_unfilled"
  | "reviewer_not_independent"
  | "launch_unknown"
  | "drained"
  | "release_refused"
  | "takeover_unsafe"
  | "orca_version_unsupported"
  | "receipt_stale_sha"
  | "receipt_no_deploy"
  | "receipt_unverified_source"
  | "docs_section_not_found"
  | "docs_port_missing"
  | "config_invalid"
  | "decision_not_gate"
  | "decision_denied"
  | "decision_budget_exhausted"
  | "gate_lift_refused"
  | "failed";

const exits: Partial<Record<ErrorCode, number>> = {
  usage: 2,
  schema_invalid: 2,
  launch_unknown: 4,
  drained: 5,
  failed: 1,
};

export function exitFor(code: ErrorCode): number {
  return exits[code] ?? 3;
}

export class PodError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly exit: number,
    message: string,
    readonly nextSteps: readonly string[],
  ) {
    super(message);
  }
}

export function usageError(
  message: string,
  nextSteps: readonly string[] = ["pod --help"],
): PodError {
  return new PodError("usage", 2, message, nextSteps);
}

export function schemaError(
  message: string,
  nextSteps: readonly string[],
): PodError {
  return new PodError("schema_invalid", 2, message, nextSteps);
}

export function throwRecordRefusal(
  refusals: readonly { message: string }[],
): void {
  const [refused] = refusals;
  if (refused !== undefined)
    throw new PodError("failed", 1, refused.message, [
      "the ledger recorded the call's outcome; add the term to the scrubber inputs and record again",
    ]);
}
