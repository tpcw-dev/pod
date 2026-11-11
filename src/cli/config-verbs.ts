import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  applyConfig,
  revisionRef,
  type ApplyOutcome,
} from "../core/config/apply.ts";
import {
  mirrorPath,
  mirrorSet,
  mirrorYaml,
  scopeText,
} from "../core/config/mirror.ts";
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
import { actorOf, writerOf, type Identity } from "./identity.ts";
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
      profile: z.string().nullable(),
      comment: z.string(),
      ticket: z.string().nullable(),
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

function activationRequest(
  identity: Identity,
  envelope: RevisionEnvelope,
  ticket: string | undefined,
  host: string,
  expected?: string | null,
) {
  if (identity.kind === "person" || envelope.kind === "task") return null;
  if (ticket === undefined)
    throw usageError(
      `${actorOf(identity)} is an agent Seat, and its Revision waits for a person to activate it`,
      [
        "pass --ticket <key> naming the ticket where a person posts the approval comment",
      ],
    );
  return expected === undefined ? { host } : { host, expected };
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
    const identity = await writerOf(
      connection.db,
      host,
      process.env,
      flags !== null,
    );
    const outcome = await applyConfig(connection.db, {
      envelope,
      actor: actorOf(identity),
      reason: input.reason ?? "",
      ticket: input.ticket ?? null,
      now: new Date(),
      activate: flags === null ? null : { ...flags, host: host.hostId },
      request:
        flags === null
          ? activationRequest(identity, envelope, input.ticket, host.hostId)
          : null,
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
    const identity = await writerOf(connection.db, host, process.env, activate);
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
      actor: actorOf(identity),
      reason: input.reason,
      ticket: input.ticket ?? null,
      verb: "config set",
      now: new Date(),
      activate: activate
        ? { expected: derived.expected, opKey: null, host: host.hostId }
        : null,
      request: activate
        ? null
        : activationRequest(
            identity,
            envelope.data,
            input.ticket,
            host.hostId,
            derived.expected,
          ),
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

export const ConfigActivateInput = z.strictObject({
  args: z.tuple([z.string()]),
  scope: z.string(),
  "expected-revision": z.string(),
  "op-key": z.string().min(1).optional(),
  reason: z.string().optional(),
});

export async function configActivate(
  input: z.infer<typeof ConfigActivateInput>,
): Promise<z.infer<typeof ConfigApplyOutput>> {
  const [ref] = input.args;
  const { kind, name, rev } = parseRef(ref);
  const expected = expectedFlag(input["expected-revision"]);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const identity = await writerOf(connection.db, host, process.env, true);
    const revision = await connection.db.getRevisionByRef(kind, name, rev);
    if (revision === null)
      throw new PodError("revision_not_found", 3, `no Revision ${ref}`, [
        "pod config apply FILE",
      ]);
    if (input.scope !== scopeText(revision))
      throw usageError(
        `--scope ${input.scope} differs from ${ref}'s scope ${scopeText(revision)}`,
      );
    const outcome = await applyConfig(connection.db, {
      envelope: envelopeOf(revision),
      actor: actorOf(identity),
      reason: input.reason ?? revision.reason,
      ticket: revision.ticket ?? null,
      verb: "config activate",
      now: new Date(),
      activate: {
        expected,
        opKey: input["op-key"] ?? null,
        host: host.hostId,
      },
    });
    return settle(outcome, ref, (active) => [
      `pod config activate ${ref} --scope ${input.scope} --expected-revision ${active?.id ?? "none"}`,
    ]);
  } finally {
    await connection.close();
  }
}

function envelopeOf(revision: Revision): RevisionEnvelope {
  return {
    kind: revision.kind,
    name: revision.name,
    schema_version: revision.schema_version,
    scope: revision.scope,
    scope_ref: revision.scope_ref,
    parent: revision.parent,
    value: revision.value,
  };
}

export const ConfigExportInput = z.strictObject({
  args: z.union([z.tuple([]), z.tuple([z.string()])]),
  out: z.string().min(1).optional(),
  all: z.boolean().optional(),
  prune: z.boolean().optional(),
});
type ConfigExportInput = z.infer<typeof ConfigExportInput>;

const ExportOneOutput = z.object({
  ref: z.string(),
  id: z.string(),
  out: z.string(),
});

const ExportAllOutput = z.object({
  dir: z.string(),
  files: z.array(
    z.object({
      ref: z.string(),
      id: z.string(),
      scope: z.string(),
      path: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({
      ref: z.string(),
      id: z.string(),
      scope: z.string(),
      reason: z.string(),
    }),
  ),
  orphans: z.array(z.string()),
  pruned: z.boolean(),
  nextSteps: z.array(z.string()),
});

export const ConfigExportOutput = z.union([ExportOneOutput, ExportAllOutput]);

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

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return entry.isFile() && entry.name.endsWith(".yaml") ? [path] : [];
  });
}

async function exportAll(
  prune: boolean,
): Promise<z.infer<typeof ExportAllOutput>> {
  const host = readHostProfile();
  const dir = host.mirrorDir;
  if (existsSync(dir) && !statSync(dir).isDirectory())
    throw usageError(`${dir} is not a directory`, [
      "set mirror_dir in the host profile to a directory",
    ]);
  const connection = connect(databaseUrl(host));
  try {
    const result: z.infer<typeof ExportAllOutput> = {
      dir,
      files: [],
      skipped: [],
      orphans: [],
      pruned: prune,
      nextSteps: [
        `git -C ${dir} add -A`,
        `git -C ${dir} commit -m "pod config export --all"`,
      ],
    };
    for (const revision of await mirrorSet(connection.db)) {
      const row = {
        ref: revisionRef(revision),
        id: revision.id,
        scope: scopeText(revision),
      };
      const path = mirrorPath(dir, revision);
      if (path === null) {
        result.skipped.push({ ...row, reason: "unsafe name or scope_ref" });
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, mirrorYaml(revision));
      result.files.push({ ...row, path });
    }
    const written = new Set(result.files.map((file) => file.path));
    result.orphans = yamlFiles(dir)
      .filter((path) => !written.has(path))
      .sort();
    if (prune) for (const path of result.orphans) rmSync(path);
    return result;
  } finally {
    await connection.close();
  }
}

async function exportOne(
  ref: string,
  out: string,
): Promise<z.infer<typeof ExportOneOutput>> {
  const { kind, name, rev } = parseRef(ref);
  const connection = connect(databaseUrl(readHostProfile()));
  try {
    const revision = await connection.db.getRevisionByRef(kind, name, rev);
    if (revision === null)
      throw new PodError("revision_not_found", 3, `no Revision ${ref}`, [
        "pod config apply FILE",
      ]);
    writeFileSync(out, stringify(envelopeOf(revision)));
    return { ref, id: revision.id, out };
  } finally {
    await connection.close();
  }
}

export async function configExport(
  input: ConfigExportInput,
): Promise<z.infer<typeof ConfigExportOutput>> {
  const [ref] = input.args;
  if (input.all === true) {
    if (ref !== undefined || input.out !== undefined)
      throw usageError(
        "config export --all takes no kind.name@rev and no --out",
      );
    return exportAll(input.prune === true);
  }
  if (input.prune === true) throw usageError("--prune needs --all");
  if (ref === undefined || input.out === undefined)
    throw usageError("config export needs kind.name@rev --out FILE, or --all");
  return exportOne(ref, input.out);
}
