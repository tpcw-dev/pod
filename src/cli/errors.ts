export type ErrorCode =
  | "usage"
  | "schema_invalid"
  | "revision_conflict"
  | "revision_not_found"
  | "duplicate_op"
  | "journal_mismatch"
  | "story_not_found"
  | "failed";

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
