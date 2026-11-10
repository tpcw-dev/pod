import { z } from "zod";
import {
  Kind,
  Scope,
  type Revision,
  type RevisionEnvelope,
} from "../domain/config.ts";
import { Json } from "../domain/json.ts";
import type { Refusal } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";
import { validateDecisionTemplates } from "../decide/templates.ts";
import { fallbackProblem } from "../dispatch/seats.ts";
import { validateProcess } from "../process/validate.ts";
import { noSingleActive, singleActive } from "./active.ts";
import {
  activeProfile,
  droppedMember,
  requiredRevisions,
  validatePolicy,
} from "./policy.ts";
import { canonicalJson, revisionId, sha256Hex } from "./canonical-json.ts";

export interface ApplyInput {
  envelope: RevisionEnvelope;
  actor: string;
  reason: string;
  ticket?: string | null;
  verb?: "config apply" | "config set";
  now: Date;
  activate: {
    expected: string | null;
    opKey: string | null;
    host: string;
  } | null;
}

const AppliedActivation = z.object({
  scope: z.string(),
  scope_ref: z.string(),
  kind: z.string(),
  name: z.string(),
  revision_id: z.string(),
  previous_revision_id: z.string().nullable(),
  bundle_id: z.null(),
  op_key: z.string(),
});
export type AppliedActivation = z.infer<typeof AppliedActivation>;

const PendingProfile = z.object({
  op_key: z.string(),
  profile: z.string(),
  comment: z.string(),
  runs_on_old_profile: z.array(z.string()),
  readback: z.string(),
});

const ApplyResult = z.object({
  ref: z.string(),
  id: z.string(),
  rev: z.int(),
  created: z.boolean(),
  activation: AppliedActivation.nullable(),
  pending: PendingProfile.nullable().default(null),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export type ApplyOutcome =
  | { kind: "ok"; result: ApplyResult }
  | { kind: "parent_unknown"; parent: string | null }
  | { kind: "revision_conflict"; opKey: string; active: Revision | null }
  | { kind: "duplicate_op"; opKey: string; intent: string }
  | { kind: "operation_open"; opKey: string; status: string }
  | { kind: "process_invalid"; refusal: Refusal };

const PendingRequest = z.object({
  scope: Scope,
  scope_ref: z.string(),
  kind: Kind,
  name: z.string(),
  revision_id: z.string(),
  expected: z.string().nullable(),
  profile: z.string(),
  comment: z.string(),
});
export type PendingRequest = z.infer<typeof PendingRequest>;

const RecordedPending = z.object({
  pending: PendingRequest,
  result: ApplyResult,
});

const readbackRule =
  "the HQA keeper posts the comment on the Story of a live Run; the next pod check on that Run reads it back and activates the profile";

const RecordedRefusal = z.object({
  code: z.literal("revision_conflict"),
  active: z.string().nullable(),
});

export function revisionRef(
  revision: Pick<Revision, "kind" | "name" | "rev">,
): string {
  return `${revision.kind}.${revision.name}@${revision.rev}`;
}

export function deriveOpKey(
  envelope: RevisionEnvelope,
  expected: string | null,
  id: string,
): string {
  return `config_apply:${sha256Hex(
    canonicalJson({
      intent: "config_apply",
      scope: envelope.scope,
      scope_ref: envelope.scope_ref,
      kind: envelope.kind,
      name: envelope.name,
      expected_revision: expected ?? "none",
      revision_id: id,
    }),
  )}`;
}

async function parentKnown(tx: Repo, parent: string | null): Promise<boolean> {
  return parent === null || (await tx.getRevision(parent)) !== null;
}

async function processRefusal(
  tx: Repo,
  envelope: RevisionEnvelope,
): Promise<Refusal | null> {
  if (envelope.kind === "decision") {
    const problem = validateDecisionTemplates(envelope.value);
    return problem === null
      ? null
      : {
          code: "schema_invalid",
          message: problem.message,
          nextSteps: [problem.path],
        };
  }
  if (envelope.kind === "crew") {
    const problem = fallbackProblem(envelope.value);
    return problem === null
      ? null
      : {
          code: "schema_invalid",
          message: problem.message,
          nextSteps: [problem.path],
        };
  }
  if (envelope.kind === "policy") return policyRefusal(tx, envelope);
  if (envelope.kind !== "process") return null;
  const { scope, scope_ref } = envelope;
  const crew = await singleActive(tx, "crew", scope, scope_ref);
  if (crew === null) return noSingleActive("crew", scope, scope_ref).refusal;
  const policy = await singleActive(tx, "policy", scope, scope_ref);
  if (policy === null)
    return noSingleActive("policy", scope, scope_ref).refusal;
  const checked = validateProcess(envelope.value, crew.value, policy.value);
  return checked.ok ? null : checked.refusal;
}

async function policyRefusal(
  tx: Repo,
  envelope: RevisionEnvelope,
): Promise<Refusal | null> {
  const { scope, scope_ref, value } = envelope;
  const crew = await singleActive(tx, "crew", scope, scope_ref);
  const invalid = validatePolicy(value, crew?.value ?? null);
  if (invalid !== null) return invalid;
  for (const id of requiredRevisions(value))
    if ((await tx.getRevision(id)) === null)
      return {
        code: "revision_not_found",
        message: `a profile requires policy Revision ${id}, which does not exist`,
        nextSteps: [
          "apply that policy Revision first, or correct requires.policy_revision",
        ],
      };
  if (scope === "project") {
    const global = await singleActive(tx, "policy", "global", "");
    const dropped = global === null ? null : droppedMember(value, global.value);
    if (dropped !== null) return dropped;
  }
  const profile = activeProfile(value);
  if (profile === null) return null;
  if (profile === refusedProfile) {
    const [run] = await tx.liveRunsPinningPolicyScope(scope, scope_ref);
    const held =
      run === undefined
        ? ""
        : `Run ${run} has an open Decision or an unsettled Task, and `;
    return {
      code: "gate_lift_refused",
      message: `active_profile ${profile}: ${held}activating ${profile} waits on the step method override`,
      nextSteps: [
        "see Gate-lift in docs/tech-spec.md",
        "choose hands-on, standard, or hands-off and apply again",
      ],
    };
  }
  if (scope === "project") return null;
  return {
    code: "gate_lift_refused",
    message: `active_profile ${profile}: a profile is activated per project, not at ${scope} scope`,
    nextSteps: [
      "move active_profile into a project-scope policy and apply it with --scope project:REF",
    ],
  };
}

const refusedProfile = "autonomous";

function storeRevision(
  tx: Repo,
  input: ApplyInput,
  id: string,
): Promise<{ revision: Revision; created: boolean }> {
  return tx.insertRevision({
    ...input.envelope,
    id,
    actor: input.actor,
    reason: input.reason,
    ticket: input.ticket ?? null,
  });
}

function resultOf(
  stored: { revision: Revision; created: boolean },
  activation: AppliedActivation | null,
): ApplyResult {
  return {
    ref: revisionRef(stored.revision),
    id: stored.revision.id,
    rev: stored.revision.rev,
    created: stored.created,
    activation,
    pending: null,
  };
}

function pendingProfile(envelope: RevisionEnvelope): string | null {
  return envelope.kind === "policy" && envelope.scope === "project"
    ? activeProfile(envelope.value)
    : null;
}

async function requestProfile(
  tx: Repo,
  input: ApplyInput,
  opKey: string,
  id: string,
  profile: string,
): Promise<ApplyOutcome> {
  const stored = await storeRevision(tx, input, id);
  const { scope, scope_ref, kind, name } = input.envelope;
  const comment = `profile ${scope_ref} ${profile} ${revisionRef(stored.revision)}`;
  const result: ApplyResult = {
    ...resultOf(stored, null),
    pending: {
      op_key: opKey,
      profile,
      comment,
      runs_on_old_profile: await tx.liveRunsPinningPolicyScope(
        scope,
        scope_ref,
      ),
      readback: readbackRule,
    },
  };
  const pending: PendingRequest = {
    scope,
    scope_ref,
    kind,
    name,
    revision_id: id,
    expected: input.activate?.expected ?? null,
    profile,
    comment,
  };
  const { operation, created } = await tx.insertOperation({
    op_key: opKey,
    intent: "config_apply",
    owner_generation: 0,
    at: input.now,
    result_ref: Json.parse({ pending, result }),
  });
  if (!created) return recorded(tx, opKey, operation);
  return { kind: "ok", result };
}

export interface PendingProfileOp {
  op_key: string;
  request: PendingRequest;
}

export async function pendingProfileOps(
  repo: Repo,
): Promise<PendingProfileOp[]> {
  const rows = await repo.listOperations(["config_apply"], ["pending"]);
  return rows.flatMap((row) => {
    const parsed = RecordedPending.safeParse(row.result_ref);
    return parsed.success
      ? [{ op_key: row.op_key, request: parsed.data.pending }]
      : [];
  });
}

export interface ProfileSource {
  comment_id: string;
  author: string;
  readback_at: string;
}

export async function activatePendingProfile(
  tx: Repo,
  opKey: string,
  source: ProfileSource,
  context: { at: Date; host: string },
): Promise<string | null> {
  const operation = await tx.getOperation(opKey);
  const parsed = RecordedPending.safeParse(operation?.result_ref);
  if (operation?.status !== "pending" || !parsed.success) return null;
  const { pending, result } = parsed.data;
  const { scope, scope_ref, kind, name, revision_id, expected } = pending;
  const outcome = await tx.activate({
    scope,
    scope_ref,
    kind,
    name,
    expected,
    revision_id,
    bundle_id: null,
    activated_by: source.author,
    activated_at: context.at,
  });
  if (!outcome.ok) {
    await tx.moveOperation(
      opKey,
      "refused",
      { code: "revision_conflict", active: outcome.active },
      context.at,
    );
    return `revision_conflict: profile request ${JSON.stringify(pending.comment)} expected ${expected ?? "none"} but the active policy is ${outcome.active ?? "none"}; apply the profile again with --expected-revision ${outcome.active ?? "none"}`;
  }
  const activation: AppliedActivation = {
    scope,
    scope_ref,
    kind,
    name,
    revision_id,
    previous_revision_id: outcome.previous,
    bundle_id: null,
    op_key: opKey,
  };
  await tx.appendEvent({
    type: "activation",
    ts: context.at,
    host: context.host,
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: opKey,
    payload: {
      scope,
      scope_ref,
      kind,
      name,
      revision_id,
      previous_revision_id: outcome.previous,
      bundle_id: null,
      profile: pending.profile,
    },
    source: { kind: "tracker_comment", ...source },
  });
  await tx.moveOperation(
    opKey,
    "done",
    { ...result, activation, pending: null },
    context.at,
  );
  return null;
}

export function applyConfig(db: Db, input: ApplyInput): Promise<ApplyOutcome> {
  const id = revisionId(input.envelope);
  const { activate } = input;
  const { parent } = input.envelope;
  if (activate === null) {
    return db.transaction(async (tx): Promise<ApplyOutcome> => {
      if (!(await parentKnown(tx, parent)))
        return { kind: "parent_unknown", parent };
      const refusal = await processRefusal(tx, input.envelope);
      if (refusal !== null) return { kind: "process_invalid", refusal };
      return {
        kind: "ok",
        result: resultOf(await storeRevision(tx, input, id), null),
      };
    });
  }
  const opKey =
    activate.opKey ?? deriveOpKey(input.envelope, activate.expected, id);
  return db.transaction(async (tx): Promise<ApplyOutcome> => {
    if (!(await parentKnown(tx, parent)))
      return { kind: "parent_unknown", parent };
    const existing = await tx.getOperation(opKey);
    if (existing !== null) return recorded(tx, opKey, existing);
    const refusal = await processRefusal(tx, input.envelope);
    if (refusal !== null) return { kind: "process_invalid", refusal };
    const profile = pendingProfile(input.envelope);
    if (profile !== null) return requestProfile(tx, input, opKey, id, profile);
    const { operation, created } = await tx.insertOperation({
      op_key: opKey,
      intent: "config_apply",
      owner_generation: 0,
      at: input.now,
    });
    if (!created) return recorded(tx, opKey, operation);
    const stored = await storeRevision(tx, input, id);
    const { scope, scope_ref, kind, name } = input.envelope;
    const outcome = await tx.activate({
      scope,
      scope_ref,
      kind,
      name,
      expected: activate.expected,
      revision_id: id,
      bundle_id: null,
      activated_by: input.actor,
      activated_at: input.now,
    });
    if (!outcome.ok) {
      await tx.moveOperation(
        opKey,
        "refused",
        { code: "revision_conflict", active: outcome.active },
        input.now,
      );
      return {
        kind: "revision_conflict",
        opKey,
        active:
          outcome.active === null ? null : await tx.getRevision(outcome.active),
      };
    }
    const activation: AppliedActivation = {
      scope,
      scope_ref,
      kind,
      name,
      revision_id: id,
      previous_revision_id: outcome.previous,
      bundle_id: null,
      op_key: opKey,
    };
    await tx.appendEvent({
      type: "activation",
      ts: input.now,
      host: activate.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: {
        scope,
        scope_ref,
        kind,
        name,
        revision_id: id,
        previous_revision_id: outcome.previous,
        bundle_id: null,
      },
      source: { kind: "command", verb: input.verb ?? "config apply" },
    });
    const result = resultOf(stored, activation);
    await tx.moveOperation(opKey, "done", result, input.now);
    return { kind: "ok", result };
  });
}

async function recorded(
  tx: Repo,
  opKey: string,
  operation: { intent: string; status: string; result_ref: Json | null },
): Promise<ApplyOutcome> {
  if (operation.intent !== "config_apply")
    return { kind: "duplicate_op", opKey, intent: operation.intent };
  if (operation.status === "done")
    return { kind: "ok", result: ApplyResult.parse(operation.result_ref) };
  if (operation.status === "pending") {
    const pending = RecordedPending.safeParse(operation.result_ref);
    if (pending.success) return { kind: "ok", result: pending.data.result };
  }
  if (operation.status === "refused") {
    const refusal = RecordedRefusal.safeParse(operation.result_ref);
    if (refusal.success) {
      const { active } = refusal.data;
      return {
        kind: "revision_conflict",
        opKey,
        active: active === null ? null : await tx.getRevision(active),
      };
    }
  }
  return { kind: "operation_open", opKey, status: operation.status };
}
