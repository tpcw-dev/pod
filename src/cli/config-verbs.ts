import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  applyConfig,
  revisionRef,
  type ApplyOutcome,
} from "../core/config/apply.ts";
import { roadmapRefusal } from "../core/docs/roadmap.ts";
import {
  Kind,
  RevisionEnvelope,
  type Revision,
} from "../core/domain/config.ts";
import { exitFor, PodError, schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

const actor = "operator";

export const ConfigApplyInput = z.strictObject({
  args: z.tuple([z.string()]),
  activate: z.boolean().optional(),
  scope: z.string().optional(),
  "expected-revision": z.string().optional(),
  "op-key": z.string().min(1).optional(),
  reason: z.string().optional(),
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
  file: string,
  envelope: RevisionEnvelope,
) {
  switch (outcome.kind) {
    case "ok":
      return outcome.result;
    case "parent_unknown":
      throw schemaError(`${file} names an unknown parent`, [
        `parent: no Revision ${outcome.parent ?? ""}`,
      ]);
    case "revision_conflict":
      throw new PodError(
        "revision_conflict",
        3,
        `the active Revision is ${outcome.active === null ? "none" : revisionRef(outcome.active)}, not the expected one`,
        conflictSteps(file, envelope, outcome.active),
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

export async function configApply(
  input: ConfigApplyInput,
): Promise<z.infer<typeof ConfigApplyOutput>> {
  const [file] = input.args;
  const envelope = readEnvelope(file);
  const flags = activationFlags(input, envelope);
  const host = readHostProfile();
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
  const connection = connect(databaseUrl(host));
  try {
    const outcome = await applyConfig(connection.db, {
      envelope,
      actor,
      reason: input.reason ?? "",
      now: new Date(),
      activate: flags === null ? null : { ...flags, host: host.hostId },
    });
    return settle(outcome, file, envelope);
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
