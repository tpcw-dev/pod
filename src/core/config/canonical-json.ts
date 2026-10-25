import { createHash } from "node:crypto";

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`canonical JSON cannot hold ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface HashedEnvelope {
  kind: string;
  name: string;
  schema_version: number;
  scope: string;
  scope_ref: string;
  parent?: string | null;
  value: unknown;
}

export function revisionId(envelope: HashedEnvelope): string {
  return sha256Hex(
    canonicalJson({
      kind: envelope.kind,
      name: envelope.name,
      schema_version: envelope.schema_version,
      scope: envelope.scope,
      scope_ref: envelope.scope_ref,
      parent: envelope.parent ?? null,
      value: envelope.value,
    }),
  );
}

export function snapshotHash(
  ids: { crew: string; process: string; policy: string },
  gateMap: unknown,
): string {
  return sha256Hex(
    canonicalJson({
      crew_revision_id: ids.crew,
      process_revision_id: ids.process,
      policy_revision_id: ids.policy,
      effective_gate_map: gateMap,
    }),
  );
}
