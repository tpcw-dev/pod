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
