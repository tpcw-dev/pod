import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { addLearning, learningOpKey } from "../core/learning/add.ts";
import {
  Adoption,
  Area,
  acceptLearningFile,
  type Learning,
  type LearningFilter,
} from "../core/domain/learning.ts";
import { PodError, exitFor, schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
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

function adoptionFlag(value: string): z.infer<typeof Adoption> {
  const parsed = Adoption.safeParse(value);
  if (!parsed.success) oneOf("adoption", "new, adopted, or rejected", value);
  return parsed.data;
}

export const LearningAddInput = z.strictObject({
  args: z.tuple([z.string()]),
  area: z.string().min(1),
  project: z.string().min(1).optional(),
  "op-key": z.string().min(1).optional(),
});
type LearningAddInput = z.infer<typeof LearningAddInput>;

export const LearningAddOutput = z.object({
  id: z.number(),
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
  const projectId = input.project ?? null;
  const derived = learningOpKey({
    source_story: file.source_story,
    text: file.text,
    area,
    project_id: projectId,
  });
  const given = input["op-key"];
  if (given !== undefined && given !== derived)
    throw usageError(`--op-key must be ${derived}`, [derived]);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const outcome = await addLearning(connection.db, {
      row: {
        source_story: file.source_story,
        evidence_refs: file.evidence_refs,
        text: file.text,
        adoption: file.adoption,
        area,
        project_id: projectId,
      },
      host: host.hostId,
      now: () => new Date(),
    });
    if (!outcome.ok)
      throw new PodError(
        outcome.refusal.code,
        exitFor(outcome.refusal.code),
        outcome.refusal.message,
        outcome.refusal.nextSteps,
      );
    return {
      id: outcome.id,
      replayed: outcome.replayed,
      op_key: outcome.opKey,
    };
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
