import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  applyConfig,
  revisionRef,
  type ApplyOutcome,
} from "../core/config/apply.ts";
import { deriveSet } from "../core/config/set.ts";
import { roadmapRefusal } from "../core/docs/roadmap.ts";
import {
  Kind,
  RevisionEnvelope,
  Scope,
  type Revision,
} from "../core/domain/config.ts";
import { parseTarget, setEdit, unsetEdit } from "./config-set.ts";
import { exitFor, PodError, schemaError, usageError } from "./errors.ts";
import {
  databaseUrl,
  readHostProfile,
  type HostSettings,
} from "./host-profile.ts";
import { writerOf } from "./identity.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

export const ConfigApplyInput = z.strictObject({
  args: z.tuple([z.string()]),
  activate: z.boolean().optional(),
  scope: z.string().optional(),
  "expected-revision": z.string().optional(),
  "op-key": z.string().min(1).optional(),
  reason: z.string().optional(),
  ticket: z.string().min(1).optional(),
});
type ConfigApplyInput = z.infer<typeof ConfigApplyInput>;

export const ConfigApplyOutput = z.object({
  ref: z.string(),
  id: z.string(),
  rev: z.int(),
  created: z.boolean(),
  activation: z
    .object({
      scope: z.string(),
      scope_ref: z.string(),
      kind: z.string(),
      name: z.string(),
      revision_id: z.string(),
      previous_revision_id: z.string().nullable(),
      bundle_id: z.null(),
      op_key: z.string(),
    })
    .nullable(),
  pending: z
    .object({
      op_key: z.string(),
      profile: z.string(),
      comment: z.string(),
      runs_on_old_profile: z.array(z.string()),
      readback: z.string(),
    })
    .nullable(),
});

function scopeFlag(value: string): { scope: string; scope_ref: string } {
  const at = value.indexOf(":");
  return at === -1
    ? { scope: value, scope_ref: "" }
    : { scope: value.slice(0, at), scope_ref: value.slice(at + 1) };
}

function scopeText(envelope: { scope: string; scope_ref: string }): string {
  return envelope.scope_ref === ""
    ? envelope.scope
    : `${envelope.scope}:${envelope.scope_ref}`;
}

function expectedFlag(value: string): string | null {
  if (value === "none") return null;
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  throw usageError(
    `--expected-revision must be none or a Revision id, got ${value}`,
  );
}

function readEnvelope(path: string): RevisionEnvelope {
  const parsed = RevisionEnvelope.safeParse(parseYaml(readText(path), path));
  if (!parsed.success)
    throw schemaError(
      `${path} fails the Revision envelope schema`,
      issuesOf(parsed.error),
    );
  return parsed.data;
}

function activationFlags(input: ConfigApplyInput, envelope: RevisionEnvelope) {
  const expected = input["expected-revision"];
  if (input.activate !== true) {
    if (expected !== undefined && expected !== "none")
      throw usageError("--expected-revision needs --activate");
    if (input.scope !== undefined) throw usageError("--scope needs --activate");
    if (input["op-key"] !== undefined)
      throw usageError("--op-key needs --activate");
    return null;
  }
  if (input.scope === undefined || expected === undefined)
    throw usageError("--activate needs --scope and --expected-revision");
  const flag = scopeFlag(input.scope);
  if (flag.scope !== envelope.scope || flag.scope_ref !== envelope.scope_ref)
    throw usageError(
      `--scope ${input.scope} differs from the file's scope ${scopeText(envelope)}`,
    );
  return { expected: expectedFlag(expected), opKey: input["op-key"] ?? null };
}

function conflictSteps(
  file: string,
  envelope: RevisionEnvelope,
  active: Revision | null,
): string[] {
  const scope = scopeText(envelope);
  if (active === null)
    return [
      `pod config apply ${file} --activate --scope ${scope} --expected-revision none`,
    ];
  return [
    `pod config export ${revisionRef(active)} --out FILE`,
    `pod config apply ${file} --activate --scope ${scope} --expected-revision ${active.id}`,
  ];
}

function settle(
  outcome: ApplyOutcome,
  subject: string,
  onConflict: (active: Revision | null) => string[],
) {
  switch (outcome.kind) {
    case "ok":
      return outcome.result;
    case "parent_unknown":
      throw schemaError(`${subject} names an unknown parent`, [
        `parent: no Revision ${outcome.parent ?? ""}`,
      ]);
    case "revision_conflict":
      throw new PodError(
        "revision_conflict",
        3,
        `the active Revision is ${outcome.active === null ? "none" : revisionRef(outcome.active)}, not the expected one`,
        onConflict(outcome.active),
      );
    case "duplicate_op":
      throw new PodError(
        "duplicate_op",
        3,
        `op key ${outcome.opKey} belongs to intent ${outcome.intent}`,
        ["pass a new --op-key"],
      );
    case "process_invalid": {
      const { code, message, nextSteps } = outcome.refusal;
      throw new PodError(code, exitFor(code), message, nextSteps);
    }
    case "operation_open":
      throw new Error(`operation ${outcome.opKey} is ${outcome.status}`);
  }
}

function refuseRoadmap(envelope: RevisionEnvelope, host: HostSettings): void {
  const refusal =
    envelope.kind === "policy"
      ? roadmapRefusal(envelope.value, host.docsKind)
      : null;
  if (refusal !== null)
    throw new PodError(
      refusal.code,
      exitFor(refusal.code),
      refusal.message,
      refusal.nextSteps,
    );
}

export async function configApply(
  input: ConfigApplyInput,
): Promise<z.infer<typeof ConfigApplyOutput>> {
  const [file] = input.args;
  const envelope = readEnvelope(file);
  const flags = activationFlags(input, envelope);
  const host = readHostProfile();
  refuseRoadmap(envelope, host);
  const connection = connect(databaseUrl(host));
  try {
    const actor = await writerOf(
      connection.db,
      host,
      process.env,
      flags !== null,
    );
    const outcome = await applyConfig(connection.db, {
      envelope,
      actor,
      reason: input.reason ?? "",
      ticket: input.ticket ?? null,
      now: new Date(),
      activate: flags === null ? null : { ...flags, host: host.hostId },
    });
    return settle(outcome, file, (active) =>
      conflictSteps(file, envelope, active),
    );
  } finally {
    await connection.close();
  }
}

export const ConfigSetInput = z.strictObject({
  args: z.tuple([z.string()], z.string()),
  unset: z.array(z.string()).optional(),
  reason: z.string().min(1),
  scope: z.string().optional(),
  from: z.string().optional(),
  activate: z.boolean().optional(),
  ticket: z.string().min(1).optional(),
  string: z.boolean().optional(),
});

function setScope(value: string | undefined) {
  if (value === undefined) return null;
  const flag = scopeFlag(value);
  const scope = Scope.safeParse(flag.scope);
  if (!scope.success || (scope.data === "global") !== (flag.scope_ref === ""))
    throw usageError(`--scope ${value} is not global or scope:ref`);
  return { scope: scope.data, scope_ref: flag.scope_ref };
}

function fromRev(value: string | undefined, kind: Kind, name: string) {
  if (value === undefined) return null;
  const ref = parseRef(value);
  if (ref.kind !== kind || ref.name !== name)
    throw usageError(`--from ${value} is not a Revision of ${kind}.${name}`);
  return ref.rev;
}

export async function configSet(
  input: z.infer<typeof ConfigSetInput>,
): Promise<z.infer<typeof ConfigApplyOutput>> {
  const [target, ...pairs] = input.args;
  const { kind, name } = parseTarget(target);
  const edits = [
    ...pairs.map((pair) => setEdit(pair, input.string === true)),
    ...(input.unset ?? []).map(unsetEdit),
  ];
  if (edits.length === 0)
    throw usageError("config set needs a path=value or an --unset");
  const scope = setScope(input.scope);
  const from = fromRev(input.from, kind, name);
  const activate = input.activate === true;
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const actor = await writerOf(connection.db, host, process.env, activate);
    const derived = await deriveSet(connection.db, {
      kind,
      name,
      scope,
      from,
      edits,
    });
    switch (derived.kind) {
      case "no_source":
        throw new PodError(
          "revision_not_found",
          3,
          `${target} has no active Revision at ${input.scope ?? "global"}`,
          ["pod config apply FILE", "pass --from kind.name@rev"],
        );
      case "from_unknown":
        throw new PodError(
          "revision_not_found",
          3,
          `no Revision ${input.from ?? ""}`,
          ["pod config apply FILE"],
        );
      case "scope_mismatch":
        throw usageError(
          `--scope ${input.scope ?? ""} differs from ${revisionRef(derived.source)}'s scope ${scopeText(derived.source)}`,
        );
      case "edit_invalid":
        throw usageError(derived.message);
      case "ok":
        break;
    }
    const envelope = RevisionEnvelope.safeParse(derived.envelope);
    if (!envelope.success)
      throw schemaError(
        `the edited ${target} fails the Revision envelope schema`,
        issuesOf(envelope.error),
      );
    refuseRoadmap(envelope.data, host);
    const outcome = await applyConfig(connection.db, {
      envelope: envelope.data,
      actor,
      reason: input.reason,
      ticket: input.ticket ?? null,
      verb: "config set",
      now: new Date(),
      activate: activate
        ? { expected: derived.expected, opKey: null, host: host.hostId }
        : null,
    });
    return settle(outcome, target, (active) => [
      ...(active === null
        ? []
        : [`pod config export ${revisionRef(active)} --out FILE`]),
      `pod config set ${target} again, which derives from the Revision active now`,
    ]);
  } finally {
    await connection.close();
  }
}

export const ConfigExportInput = z.strictObject({
  args: z.tuple([z.string()]),
  out: z.string().min(1),
});

export const ConfigExportOutput = z.object({
  ref: z.string(),
  id: z.string(),
  out: z.string(),
});

function parseRef(ref: string): { kind: Kind; name: string; rev: number } {
  const match = /^([^.]+)\.(.+)@([1-9][0-9]*)$/.exec(ref);
  const kind = Kind.safeParse(match?.[1]);
  if (
    match === null ||
    match[2] === undefined ||
    match[3] === undefined ||
    !kind.success
  )
    throw usageError(`${ref} is not kind.name@rev`);
  return { kind: kind.data, name: match[2], rev: Number(match[3]) };
}

export async function configExport(
  input: z.infer<typeof ConfigExportInput>,
): Promise<z.infer<typeof ConfigExportOutput>> {
  const [ref] = input.args;
  const { kind, name, rev } = parseRef(ref);
  const connection = connect(databaseUrl(readHostProfile()));
  try {
    const revision = await connection.db.getRevisionByRef(kind, name, rev);
    if (revision === null)
      throw new PodError("revision_not_found", 3, `no Revision ${ref}`, [
        "pod config apply FILE",
      ]);
    const envelope = {
      kind: revision.kind,
      name: revision.name,
      schema_version: revision.schema_version,
      scope: revision.scope,
      scope_ref: revision.scope_ref,
      parent: revision.parent,
      value: revision.value,
    };
    writeFileSync(input.out, stringify(envelope));
    return { ref, id: revision.id, out: input.out };
  } finally {
    await connection.close();
  }
}
