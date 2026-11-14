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
import type { Operation } from "../domain/ledger.ts";
import { validateDecisionTemplates } from "../decide/templates.ts";
import { fallbackProblem } from "../dispatch/seats.ts";
import { validateProcess } from "../process/validate.ts";
import { noSingleActive, singleActive } from "./active.ts";
import { hostRefusal } from "./host.ts";
import { projectRefusal } from "./project.ts";
import { rateRefusal } from "./rate.ts";
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
  verb?: ConfigVerb;
  now: Date;
  activate: {
    expected: string | null;
    opKey: string | null;
    host: string;
  } | null;
  request?: { host: string; expected?: string | null } | null;
}

export type ConfigVerb = "config apply" | "config set" | "config activate";

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

const PendingResult = z.object({
  op_key: z.string(),
  profile: z.string().nullable(),
  comment: z.string(),
  ticket: z.string().nullable().default(null),
  runs_on_old_profile: z.array(z.string()),
  readback: z.string(),
});

const ApplyResult = z.object({
  ref: z.string(),
  id: z.string(),
  rev: z.int(),
  created: z.boolean(),
  activation: AppliedActivation.nullable(),
  pending: PendingResult.nullable().default(null),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export type ApplyOutcome =
  | { kind: "ok"; result: ApplyResult }
  | { kind: "parent_unknown"; parent: string | null }
  | { kind: "revision_conflict"; opKey: string; active: Revision | null }
  | { kind: "duplicate_op"; opKey: string; intent: string }
  | { kind: "operation_open"; opKey: string; status: string }
  | { kind: "process_invalid"; refusal: Refusal };

const ActivationRequest = z.object({
  scope: Scope,
  scope_ref: z.string(),
  kind: Kind,
  name: z.string(),
  revision_id: z.string(),
  expected: z.string().nullable(),
  profile: z.string().nullable(),
  comment: z.string(),
  ticket: z.string().nullable().default(null),
  actor: z.string().nullable().default(null),
});
export type ActivationRequest = z.infer<typeof ActivationRequest>;

const RecordedRequest = z.object({
  pending: ActivationRequest,
  result: ApplyResult,
});

const requestIntents = ["config_apply", "config_activate"] as const;

function readbackRule(ticket: string | null): string {
  const where =
    ticket === null ? "the Story of a live Run" : `ticket ${ticket}`;
  return `Ask an HQA keeper to post the comment on ${where}, then run pod check.`;
}

export function activateComment(revisionId: string): string {
  return `config activate ${revisionId}`;
}

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

function requestOpKey(
  envelope: RevisionEnvelope,
  expected: string | null,
  id: string,
  ticket: string | null,
): string {
  return `config_activate:${sha256Hex(
    canonicalJson({
      intent: "config_activate",
      scope: envelope.scope,
      scope_ref: envelope.scope_ref,
      kind: envelope.kind,
      name: envelope.name,
      expected_revision: expected ?? "none",
      revision_id: id,
      ticket: ticket ?? "none",
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
  if (envelope.kind === "host") return hostRefusal(tx, envelope);
  if (envelope.kind === "project") return projectRefusal(envelope);
  if (envelope.kind === "rate") return rateRefusal(envelope);
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
      message: `active_profile ${profile}: ${held}activating ${profile} waits until groom, plan, the operate loop, the gate set with its needs-human exit, and policy attention all land`,
      nextSteps: [
        "see The autonomous north star in docs/tech-spec.md",
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

async function openRequest(
  tx: Repo,
  input: ApplyInput,
  opKey: string,
  id: string,
  expected: string | null,
  host: string,
): Promise<ApplyOutcome> {
  const stored = await storeRevision(tx, input, id);
  const { scope, scope_ref, kind, name } = input.envelope;
  const profile = pendingProfile(input.envelope);
  const ticket = input.ticket ?? null;
  const comment =
    profile === null
      ? activateComment(id)
      : `profile ${scope_ref} ${profile} ${revisionRef(stored.revision)}`;
  const result: ApplyResult = {
    ...resultOf(stored, null),
    pending: {
      op_key: opKey,
      profile,
      comment,
      ticket,
      runs_on_old_profile:
        profile === null
          ? []
          : await tx.liveRunsPinningPolicyScope(scope, scope_ref),
      readback: readbackRule(ticket),
    },
  };
  const pending: ActivationRequest = {
    scope,
    scope_ref,
    kind,
    name,
    revision_id: id,
    expected,
    profile,
    comment,
    ticket,
    actor: input.actor,
  };
  const { operation, created } = await tx.insertOperation({
    op_key: opKey,
    intent: "config_activate",
    owner_generation: 0,
    at: input.now,
    result_ref: Json.parse({ pending, result }),
  });
  if (!created) return recorded(tx, opKey, operation);
  await tx.appendEvent({
    type: "activation_requested",
    ts: input.now,
    host,
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
      expected,
      ticket,
      actor: input.actor,
      comment,
    },
    source: { kind: "command", verb: input.verb ?? "config apply" },
  });
  return { kind: "ok", result };
}

export interface PendingActivation {
  op_key: string;
  request: ActivationRequest;
  result: ApplyResult;
}

export async function pendingActivations(
  repo: Repo,
): Promise<PendingActivation[]> {
  const rows = await repo.listOperations(requestIntents, ["pending"]);
  return rows.flatMap((row) => {
    const parsed = RecordedRequest.safeParse(row.result_ref);
    return parsed.success
      ? [
          {
            op_key: row.op_key,
            request: parsed.data.pending,
            result: parsed.data.result,
          },
        ]
      : [];
  });
}

export type ActivationSource =
  | {
      kind: "tracker_comment";
      comment_id: string;
      author: string;
      readback_at: string;
    }
  | { kind: "command"; verb: ConfigVerb };

async function closeRequests(
  tx: Repo,
  requests: readonly PendingActivation[],
  activation: AppliedActivation,
  source: ActivationSource,
  at: Date,
): Promise<void> {
  for (const row of requests)
    await tx.moveOperation(
      row.op_key,
      "done",
      Json.parse({
        ...row.result,
        activation: { ...activation, op_key: row.op_key },
        pending: null,
        source,
      }),
      at,
    );
}

async function requestsFor(
  tx: Repo,
  revisionId: string,
): Promise<PendingActivation[]> {
  return (await pendingActivations(tx)).filter(
    (row) => row.request.revision_id === revisionId,
  );
}

async function refuseRequests(
  tx: Repo,
  requests: readonly PendingActivation[],
  request: ActivationRequest,
  active: string | null,
  source: { comment_id: string },
  at: Date,
): Promise<string> {
  for (const row of requests)
    await tx.moveOperation(
      row.op_key,
      "refused",
      { code: "revision_conflict", active, comment_id: source.comment_id },
      at,
    );
  return `revision_conflict: config activate request for ${request.kind}.${request.name} Revision ${request.revision_id} expected ${request.expected ?? "none"} but the active Revision is ${active ?? "none"}. Write the Revision again from the active one.`;
}

export async function activateRequested(
  tx: Repo,
  revisionId: string,
  source: Extract<ActivationSource, { kind: "tracker_comment" }>,
  context: { at: Date; host: string; activatedBy: string },
): Promise<string | null> {
  const requests = await requestsFor(tx, revisionId);
  const [first] = requests;
  if (first === undefined) return null;
  const { scope, scope_ref, kind, name } = first.request;
  const active =
    (await tx.getActivation({ scope, scope_ref, kind, name }))?.revision_id ??
    null;
  const chosen = requests.find((row) => row.request.expected === active);
  if (chosen === undefined)
    return refuseRequests(
      tx,
      requests,
      first.request,
      active,
      source,
      context.at,
    );
  const outcome = await tx.activate({
    scope,
    scope_ref,
    kind,
    name,
    expected: active,
    revision_id: revisionId,
    bundle_id: null,
    activated_by: context.activatedBy,
    activated_at: context.at,
  });
  if (!outcome.ok)
    return refuseRequests(
      tx,
      requests,
      first.request,
      outcome.active,
      source,
      context.at,
    );
  const activation: AppliedActivation = {
    scope,
    scope_ref,
    kind,
    name,
    revision_id: revisionId,
    previous_revision_id: outcome.previous,
    bundle_id: null,
    op_key: chosen.op_key,
  };
  const { profile } = chosen.request;
  await tx.appendEvent({
    type: "activation",
    ts: context.at,
    host: context.host,
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: chosen.op_key,
    payload: {
      scope,
      scope_ref,
      kind,
      name,
      revision_id: revisionId,
      previous_revision_id: outcome.previous,
      bundle_id: null,
      ...(profile === null ? {} : { profile }),
    },
    source,
  });
  await closeRequests(tx, requests, activation, source, context.at);
  return null;
}

export function applyConfig(db: Db, input: ApplyInput): Promise<ApplyOutcome> {
  const id = revisionId(input.envelope);
  const { activate } = input;
  const { parent } = input.envelope;
  if (activate === null) {
    const { request } = input;
    return db.transaction(async (tx): Promise<ApplyOutcome> => {
      if (!(await parentKnown(tx, parent)))
        return { kind: "parent_unknown", parent };
      const refusal = await processRefusal(tx, input.envelope);
      if (refusal !== null) return { kind: "process_invalid", refusal };
      if (request === undefined || request === null)
        return {
          kind: "ok",
          result: resultOf(await storeRevision(tx, input, id), null),
        };
      return requestActivation(tx, input, id, request);
    });
  }
  const direct =
    input.verb === "config activate" || pendingProfile(input.envelope) === null;
  const baseKey =
    activate.opKey ??
    (direct
      ? deriveOpKey(input.envelope, activate.expected, id)
      : requestOpKey(
          input.envelope,
          activate.expected,
          id,
          input.ticket ?? null,
        ));
  const walk = activate.opKey === null && input.verb === "config activate";
  return db.transaction(async (tx): Promise<ApplyOutcome> => {
    if (!(await parentKnown(tx, parent)))
      return { kind: "parent_unknown", parent };
    const { opKey, existing } = walk
      ? await freshKey(tx, baseKey, (row) =>
          replaysActivation(tx, input, id, row),
        )
      : { opKey: baseKey, existing: await tx.getOperation(baseKey) };
    if (existing !== null) return recorded(tx, opKey, existing);
    const refusal = await processRefusal(tx, input.envelope);
    if (refusal !== null) return { kind: "process_invalid", refusal };
    if (!direct)
      return openRequest(
        tx,
        input,
        opKey,
        id,
        activate.expected,
        activate.host,
      );
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
    await closeRequests(
      tx,
      await requestsFor(tx, id),
      activation,
      { kind: "command", verb: input.verb ?? "config apply" },
      input.now,
    );
    return { kind: "ok", result };
  });
}

async function freshKey(
  tx: Repo,
  base: string,
  replay: (row: Operation) => boolean | Promise<boolean>,
): Promise<{ opKey: string; existing: Operation | null }> {
  for (let attempt = 1; ; attempt += 1) {
    const opKey = attempt === 1 ? base : `${base}:${attempt}`;
    const existing = await tx.getOperation(opKey);
    if (existing === null || (await replay(existing)))
      return { opKey, existing };
  }
}

function isRequestIntent(row: Operation): boolean {
  return (requestIntents as readonly string[]).includes(row.intent);
}

function settledRequest(row: Operation): boolean {
  return (
    isRequestIntent(row) && (row.status === "done" || row.status === "refused")
  );
}

async function replaysActivation(
  tx: Repo,
  input: ApplyInput,
  id: string,
  row: Operation,
): Promise<boolean> {
  if (!isRequestIntent(row)) return true;
  if (row.status !== "done") return false;
  const { scope, scope_ref, kind, name } = input.envelope;
  const active = await tx.getActivation({ scope, scope_ref, kind, name });
  return active?.revision_id === id;
}

async function requestActivation(
  tx: Repo,
  input: ApplyInput,
  id: string,
  request: NonNullable<ApplyInput["request"]>,
): Promise<ApplyOutcome> {
  const { scope, scope_ref, kind, name } = input.envelope;
  const active =
    (await tx.getActivation({ scope, scope_ref, kind, name }))?.revision_id ??
    null;
  if (active === id)
    return {
      kind: "ok",
      result: resultOf(await storeRevision(tx, input, id), null),
    };
  const expected = request.expected === undefined ? active : request.expected;
  const { opKey, existing } = await freshKey(
    tx,
    requestOpKey(input.envelope, expected, id, input.ticket ?? null),
    (row) => !settledRequest(row),
  );
  if (existing !== null) return recorded(tx, opKey, existing);
  return openRequest(tx, input, opKey, id, expected, request.host);
}

async function recorded(
  tx: Repo,
  opKey: string,
  operation: { intent: string; status: string; result_ref: Json | null },
): Promise<ApplyOutcome> {
  if (!(requestIntents as readonly string[]).includes(operation.intent))
    return { kind: "duplicate_op", opKey, intent: operation.intent };
  if (operation.status === "done")
    return { kind: "ok", result: ApplyResult.parse(operation.result_ref) };
  if (operation.status === "pending") {
    const pending = RecordedRequest.safeParse(operation.result_ref);
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
