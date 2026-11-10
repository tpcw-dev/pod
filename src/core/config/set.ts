import type {
  Kind,
  Revision,
  RevisionEnvelope,
  Scope,
} from "../domain/config.ts";
import type { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";
import { canonicalJson } from "./canonical-json.ts";

export type PathPart = string | number;

export type Edit =
  | { op: "set"; path: readonly PathPart[]; value: Json }
  | { op: "unset"; path: readonly PathPart[] };

export interface SetRequest {
  kind: Kind;
  name: string;
  scope: { scope: Scope; scope_ref: string } | null;
  from: number | null;
  edits: readonly Edit[];
}

export type SetOutcome =
  | {
      kind: "ok";
      source: Revision;
      envelope: RevisionEnvelope;
      expected: string | null;
    }
  | { kind: "no_source" }
  | { kind: "from_unknown" }
  | { kind: "scope_mismatch"; source: Revision }
  | { kind: "edit_invalid"; message: string };

class EditError extends Error {}

type Container = Json[] | { [key: string]: Json };

function isContainer(value: Json | undefined): value is Container {
  return typeof value === "object" && value !== null;
}

export function pathText(path: readonly PathPart[]): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`,
    )
    .join("");
}

function child(
  container: Container,
  part: PathPart,
  path: readonly PathPart[],
): Json | undefined {
  if (Array.isArray(container)) {
    if (typeof part !== "number" || part >= container.length)
      throw new EditError(`${pathText(path)}: no element ${String(part)}`);
    return container[part];
  }
  if (typeof part === "number")
    throw new EditError(`${pathText(path)}: [${part}] indexes a map`);
  return container[part];
}

function parentOf(root: Json, path: readonly PathPart[], create: boolean) {
  let node: Json = root;
  for (const [index, part] of path.slice(0, -1).entries()) {
    if (!isContainer(node))
      throw new EditError(`${pathText(path)}: ${pathText(path.slice(0, index))} is not a map or a list`);
    let next = child(node, part, path);
    if (next === undefined) {
      if (!create) throw new EditError(`${pathText(path)}: no such path`);
      next = {};
      (node as Record<string, Json>)[part as string] = next;
    }
    node = next;
  }
  if (!isContainer(node))
    throw new EditError(`${pathText(path)}: ${pathText(path.slice(0, -1))} is not a map or a list`);
  return node;
}

function applyEdit(root: Json, edit: Edit): void {
  const last = edit.path.at(-1);
  if (last === undefined) throw new EditError("an empty path");
  const parent = parentOf(root, edit.path, edit.op === "set");
  if (Array.isArray(parent)) {
    child(parent, last, edit.path);
    const index = last as number;
    if (edit.op === "set") parent[index] = edit.value;
    else parent.splice(index, 1);
    return;
  }
  if (typeof last === "number")
    throw new EditError(`${pathText(edit.path)}: [${last}] indexes a map`);
  if (edit.op === "set") {
    parent[last] = edit.value;
    return;
  }
  if (!(last in parent))
    throw new EditError(`${pathText(edit.path)}: no such path`);
  delete parent[last];
}

export function editValue(
  value: Json,
  edits: readonly Edit[],
): { ok: true; value: Json } | { ok: false; message: string } {
  const copy = structuredClone(value);
  const ordered = [
    ...edits.filter((edit) => edit.op === "set"),
    ...edits.filter((edit) => edit.op === "unset"),
  ];
  try {
    for (const edit of ordered) applyEdit(copy, edit);
  } catch (error) {
    if (error instanceof EditError) return { ok: false, message: error.message };
    throw error;
  }
  if (canonicalJson(copy) === canonicalJson(value))
    return { ok: false, message: "the edits leave the value unchanged" };
  return { ok: true, value: copy };
}

async function activeAt(
  repo: Repo,
  request: SetRequest,
  scope: { scope: Scope; scope_ref: string },
): Promise<Revision | null> {
  const activation = await repo.getActivation({
    ...scope,
    kind: request.kind,
    name: request.name,
  });
  return activation === null ? null : repo.getRevision(activation.revision_id);
}

const globalScope = { scope: "global", scope_ref: "" } as const;

export async function deriveSet(
  repo: Repo,
  request: SetRequest,
): Promise<SetOutcome> {
  const from =
    request.from === null
      ? null
      : await repo.getRevisionByRef(request.kind, request.name, request.from);
  if (request.from !== null && from === null) return { kind: "from_unknown" };
  if (
    from !== null &&
    request.scope !== null &&
    (from.scope !== request.scope.scope ||
      from.scope_ref !== request.scope.scope_ref)
  )
    return { kind: "scope_mismatch", source: from };
  const active = await activeAt(
    repo,
    request,
    from ?? request.scope ?? globalScope,
  );
  const source = from ?? active;
  if (source === null) return { kind: "no_source" };
  const edited = editValue(source.value, request.edits);
  if (!edited.ok) return { kind: "edit_invalid", message: edited.message };
  return {
    kind: "ok",
    source,
    expected: active?.id ?? null,
    envelope: {
      kind: source.kind,
      name: source.name,
      schema_version: source.schema_version,
      scope: source.scope,
      scope_ref: source.scope_ref,
      parent: source.id,
      value: edited.value,
    },
  };
}
