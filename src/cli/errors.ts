export const errorCodes = [
  "usage",
  "schema_invalid",
  "revision_conflict",
  "revision_not_found",
  "duplicate_op",
  "journal_mismatch",
  "story_not_found",
  "selector_none",
  "selector_conflict",
  "selector_many",
  "owner_generation_stale",
  "task_not_ready",
  "quota_exhausted",
  "role_unfilled",
  "reviewer_not_independent",
  "launch_unknown",
  "drained",
  "release_refused",
  "takeover_unsafe",
  "orca_version_unsupported",
  "receipt_stale_sha",
  "receipt_no_deploy",
  "receipt_unverified_source",
  "receipt_keeper_is_decision_seat",
  "docs_section_not_found",
  "docs_port_missing",
  "config_invalid",
  "decision_not_gate",
  "decision_denied",
  "decision_budget_exhausted",
  "gate_lift_refused",
  "deploy_revision_mismatch",
  "deploy_not_waiting",
  "identity_missing",
  "activation_needs_person",
  "owed_work",
  "unanswered_question",
  "needs_file",
  "tracker_unconfirmed",
  "story_canceled",
  "open_pr",
  "wrong_host",
  "learning_kind_unknown",
  "learning_match_ambiguous",
  "retro_not_due",
  "ruling_exists",
  "not_held",
  "not_marked",
  "tracker_partial",
  "config_missing",
  "usage_hold",
  "attention_paused",
  "failed",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export type ErrorClass = "guardrail" | "data";

/** A guardrail is a rule the operator chose refusing the call; data is a wrong input, state, or environment. */
export const errorClasses: Record<ErrorCode, ErrorClass> = {
  usage: "data",
  schema_invalid: "data",
  revision_conflict: "data",
  revision_not_found: "data",
  duplicate_op: "data",
  journal_mismatch: "data",
  story_not_found: "data",
  selector_none: "data",
  selector_conflict: "data",
  selector_many: "data",
  owner_generation_stale: "data",
  task_not_ready: "guardrail",
  quota_exhausted: "guardrail",
  role_unfilled: "guardrail",
  reviewer_not_independent: "guardrail",
  launch_unknown: "data",
  drained: "guardrail",
  release_refused: "guardrail",
  takeover_unsafe: "guardrail",
  orca_version_unsupported: "data",
  receipt_stale_sha: "guardrail",
  receipt_no_deploy: "guardrail",
  receipt_unverified_source: "guardrail",
  receipt_keeper_is_decision_seat: "guardrail",
  docs_section_not_found: "data",
  docs_port_missing: "data",
  config_invalid: "data",
  decision_not_gate: "data",
  decision_denied: "guardrail",
  decision_budget_exhausted: "guardrail",
  gate_lift_refused: "guardrail",
  deploy_revision_mismatch: "guardrail",
  deploy_not_waiting: "guardrail",
  identity_missing: "data",
  activation_needs_person: "guardrail",
  owed_work: "guardrail",
  unanswered_question: "guardrail",
  needs_file: "guardrail",
  tracker_unconfirmed: "data",
  story_canceled: "guardrail",
  open_pr: "guardrail",
  wrong_host: "guardrail",
  learning_kind_unknown: "data",
  learning_match_ambiguous: "data",
  retro_not_due: "guardrail",
  ruling_exists: "guardrail",
  not_held: "data",
  not_marked: "data",
  tracker_partial: "data",
  config_missing: "data",
  usage_hold: "guardrail",
  attention_paused: "guardrail",
  failed: "data",
};

export const guardrailCodes: readonly ErrorCode[] = errorCodes.filter(
  (code) => errorClasses[code] === "guardrail",
);

const exits: Partial<Record<ErrorCode, number>> = {
  usage: 2,
  schema_invalid: 2,
  launch_unknown: 4,
  tracker_unconfirmed: 4,
  tracker_partial: 4,
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
