import { parse } from "yaml";
import type { Edit, PathPart } from "../core/config/set.ts";
import { Kind } from "../core/domain/config.ts";
import { Json } from "../core/domain/json.ts";
import { usageError } from "./errors.ts";

const pathForm = /^[^.[\]=]+(?:\.[^.[\]=]+|\[\d+\])*$/;

function parsePath(text: string): PathPart[] {
  if (!pathForm.test(text))
    throw usageError(`${text} is not a path like key.key[0].key`);
  return [...text.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[2] === undefined ? (match[1] ?? "") : Number(match[2]),
  );
}

function parseValue(text: string, path: string): Json {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw usageError(`${path}: ${text} is not a YAML flow value`, [
      "quote the value, or pass --string",
    ]);
  }
  const json = Json.safeParse(value);
  if (!json.success) throw usageError(`${path}: ${text} is not a JSON value`);
  return json.data;
}

export function setEdit(pair: string, asString: boolean): Edit {
  const at = pair.indexOf("=");
  if (at === -1) throw usageError(`${pair} is not path=value`);
  const path = pair.slice(0, at);
  const text = pair.slice(at + 1);
  return {
    op: "set",
    path: parsePath(path),
    value: asString ? text : parseValue(text, path),
  };
}

export function unsetEdit(path: string): Edit {
  return { op: "unset", path: parsePath(path) };
}

export function parseTarget(target: string): { kind: Kind; name: string } {
  const at = target.indexOf(".");
  const kind = Kind.safeParse(at === -1 ? undefined : target.slice(0, at));
  const name = target.slice(at + 1);
  if (!kind.success || name === "")
    throw usageError(`${target} is not kind.name`);
  return { kind: kind.data, name };
}
