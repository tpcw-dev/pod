import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { schemaError, usageError } from "./errors.ts";

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(`cannot read ${path}`, [reason]);
  }
}

export function parseYaml(text: string, path: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  const [first] = doc.errors;
  if (first !== undefined)
    throw schemaError(`${path} is not valid YAML`, [first.message]);
  return doc.toJS();
}

export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}
