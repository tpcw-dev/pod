import { z } from "zod";
import type { Revision, RevisionEnvelope } from "../domain/config.ts";
import type { Json } from "../domain/json.ts";
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

const ApplyResult = z.object({
  ref: z.string(),
  id: z.string(),
  rev: z.int(),
  created: z.boolean(),
  activation: AppliedActivation.nullable(),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export type ApplyOutcome =
  | { kind: "ok"; result: ApplyResult }
  | { kind: "parent_unknown"; parent: string | null }
  | { kind: "revision_conflict"; opKey: string; active: Revision | null }
  | { kind: "duplicate_op"; opKey: string; intent: string }
  | { kind: "operation_open"; opKey: string; status: string }
  | { kind: "process_invalid"; refusal: Refusal };

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
  const [run] = await tx.liveRunsPinningPolicyScope(scope, scope_ref);
  return {
    code: "gate_lift_refused",
    message:
      run === undefined
        ? `active_profile ${profile}: profile activation is refused in v1`
        : `active_profile ${profile}: Run ${run} has an open Decision or an unsettled Task, and profile activation is refused in v1`,
    nextSteps: ["remove active_profile and apply again"],
  };
}

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
  };
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
      source: { kind: "command", verb: "config apply" },
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
