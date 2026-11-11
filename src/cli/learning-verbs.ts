import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  addLearning,
  learningIdentity,
  learningOpKey,
} from "../core/learning/add.ts";
import { importLearnings } from "../core/learning/import.ts";
import {
  Adoption,
  Area,
  Reporter,
  acceptImportFile,
  acceptLearningFile,
  type Learning,
  type LearningFilter,
} from "../core/domain/learning.ts";
import type { Refusal } from "../core/domain/outcome.ts";
import { PodError, exitFor, schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { writerOf } from "./identity.ts";
import { parseYaml, readText } from "./yaml-file.ts";

export function readLearningFile(path: string) {
  const parsed = parseYaml(readText(path), path);
  const accepted = acceptLearningFile(parsed);
  if (!accepted.ok)
    throw schemaError(
      `${path} fails the learning file schema`,
      accepted.issues,
    );
  return accepted.file;
}

function oneOf(flag: string, allowed: string, value: string): never {
  throw usageError(`--${flag} must be ${allowed}, got ${value}`);
}

function areaFlag(value: string): z.infer<typeof Area> {
  const parsed = Area.safeParse(value);
  if (!parsed.success)
    oneOf("area", "product, design, impl, or process", value);
  return parsed.data;
}

function reporterFlag(value: string | undefined): z.infer<typeof Reporter> {
  if (value === undefined) return "lead";
  const parsed = Reporter.safeParse(value);
  if (!parsed.success) oneOf("reporter", "lead, retro, or healthcheck", value);
  return parsed.data;
}

function repeatOfFlag(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*$/u.test(value))
    throw usageError(`--repeat-of must be a positive integer, got ${value}`);
  return Number(value);
}

function expectedOf(flag: string | undefined, file: string | undefined) {
  if (flag !== undefined && file !== undefined && flag !== file)
    throw usageError(
      "--expected and the file's expected differ; pass one of them",
    );
  return flag ?? file ?? null;
}

function failWith(refusal: Refusal): never {
  throw new PodError(
    refusal.code,
    exitFor(refusal.code),
    refusal.message,
    refusal.nextSteps,
  );
}

function adoptionFlag(value: string): z.infer<typeof Adoption> {
  const parsed = Adoption.safeParse(value);
  if (!parsed.success)
    oneOf("adoption", "new, proposed, adopted, rejected, or done", value);
  return parsed.data;
}

export const LearningAddInput = z.strictObject({
  args: z.tuple([z.string()]),
  area: z.string().min(1),
  kind: z.string().min(1),
  project: z.string().min(1).optional(),
  reporter: z.string().min(1).optional(),
  expected: z.string().min(1).optional(),
  "repeat-of": z.string().min(1).optional(),
  "op-key": z.string().min(1).optional(),
});
type LearningAddInput = z.infer<typeof LearningAddInput>;

export const LearningAddOutput = z.object({
  id: z.number(),
  occurrence_id: z.number(),
  replayed: z.boolean(),
  op_key: z.string(),
});
type LearningAddOutput = z.infer<typeof LearningAddOutput>;

export function learningAddMeta(output: LearningAddOutput) {
  return { opKey: output.op_key };
}

export async function learningAdd(
  input: LearningAddInput,
): Promise<LearningAddOutput> {
  const area = areaFlag(input.area);
  const [path] = input.args;
  const file = readLearningFile(path);
  const row = {
    source_story: file.source_story,
    evidence_refs: file.evidence_refs,
    text: file.text,
    adoption: file.adoption,
    area,
    project_id: input.project ?? null,
    kind: input.kind,
    expected: expectedOf(input.expected, file.expected),
    reporter: reporterFlag(input.reporter),
    repeat_of: repeatOfFlag(input["repeat-of"]),
  };
  const derived = learningOpKey(learningIdentity(row));
  const given = input["op-key"];
  if (given !== undefined && given !== derived)
    throw usageError(`--op-key must be ${derived}`, [derived]);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const outcome = await addLearning(connection.db, {
      row,
      host: host.hostId,
      now: () => new Date(),
    });
    if (!outcome.ok) failWith(outcome.refusal);
    return {
      id: outcome.id,
      occurrence_id: outcome.occurrence_id,
      replayed: outcome.replayed,
      op_key: outcome.opKey,
    };
  } finally {
    await connection.close();
  }
}

export const LearningImportInput = z.strictObject({
  args: z.tuple([z.string()]),
});
type LearningImportInput = z.infer<typeof LearningImportInput>;

export const LearningImportOutput = z.object({
  rows: z.array(
    z.object({ source_ref: z.string(), id: z.number(), replayed: z.boolean() }),
  ),
});
type LearningImportOutput = z.infer<typeof LearningImportOutput>;

export async function learningImport(
  input: LearningImportInput,
): Promise<LearningImportOutput> {
  const [path] = input.args;
  const accepted = acceptImportFile(parseYaml(readText(path), path));
  if (!accepted.ok)
    throw schemaError(`${path} fails the learning import schema`, accepted.issues);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const identity = await writerOf(connection.db, host, process.env, false);
    if (identity.kind === "seat")
      throw usageError(`learning import is operator only; ${identity.address} is a Seat`, [
        "Run pod learning import from the operator's shell",
      ]);
    const outcome = await importLearnings(connection.db, {
      rows: accepted.rows,
      host: host.hostId,
      now: () => new Date(),
    });
    if (!outcome.ok) failWith(outcome.refusal);
    return { rows: outcome.rows };
  } finally {
    await connection.close();
  }
}

const printed = z.object({
  id: z.number(),
  source_story: z.string(),
  evidence_refs: z.array(z.string()),
  text: z.string(),
  adoption: Adoption,
  area: Area,
  project_id: z.string().nullable(),
  kind: z.string(),
  theme: z.string().nullable(),
  action_story: z.string().nullable(),
  occurrences: z.number(),
  created_at: z.string(),
});

export const LearningQueryInput = z.strictObject({
  args: z.tuple([]),
  story: z.string().min(1).optional(),
  adoption: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
});
type LearningQueryInput = z.infer<typeof LearningQueryInput>;

export const LearningQueryOutput = z.object({
  learnings: z.array(printed),
});
type LearningQueryOutput = z.infer<typeof LearningQueryOutput>;

function printRow(row: Learning): z.infer<typeof printed> {
  return {
    id: row.id,
    source_story: row.source_story,
    evidence_refs: row.evidence_refs,
    text: row.text,
    adoption: row.adoption,
    area: row.area,
    project_id: row.project_id,
    kind: row.kind,
    theme: row.theme,
    action_story: row.action_story,
    occurrences: row.occurrences,
    created_at: row.created_at.toISOString(),
  };
}

export async function learningQuery(
  input: LearningQueryInput,
): Promise<LearningQueryOutput> {
  const filter: LearningFilter = {};
  if (input.story !== undefined) filter.story = input.story;
  if (input.adoption !== undefined)
    filter.adoption = adoptionFlag(input.adoption);
  if (input.text !== undefined) filter.text = input.text;
  if (input.area !== undefined) filter.area = areaFlag(input.area);
  if (input.project !== undefined) filter.project = input.project;
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const rows = await connection.db.listLearnings(filter);
    return { learnings: rows.map(printRow) };
  } finally {
    await connection.close();
  }
}
