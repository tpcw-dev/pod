import { z } from "zod";
import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import { singleActive } from "../config/active.ts";
import { learningKinds } from "../config/learning-kinds.ts";
import { Json } from "../domain/json.ts";
import {
  Adoption,
  Area,
  Reporter,
  type Learning,
  type LearningIdentity,
} from "../domain/learning.ts";
import type { Operation } from "../domain/ledger.ts";
import { refuse, RefusalCode, type Refusal } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";
import {
  evidenceId,
  matchLearning,
  normalizeExpected,
  reopenedAdoption,
  sortedRefs,
} from "./match.ts";

export interface LearningRow {
  source_story: string;
  evidence_refs: string[];
  text: string;
  adoption: Adoption;
  area: Area;
  project_id: string | null;
  kind: string;
  expected?: string | null;
  reporter: Reporter;
  repeat_of?: number | null;
}

export interface AddLearningInput {
  row: LearningRow;
  host: string;
  now: () => Date;
  run_id?: string;
  verb?: string;
}

export type Added =
  | {
      ok: true;
      id: number;
      occurrence_id: number;
      replayed: boolean;
      opKey: string;
    }
  | { ok: false; refusal: Refusal };

type Refused = Extract<Added, { ok: false }>;

const Request = z.object({
  source_story: z.string(),
  text: z.string(),
  area: Area,
  project_id: z.string().nullable(),
  kind: z.string(),
  expected: z.string().nullable(),
  evidence_refs: z.array(z.string()),
  reporter: Reporter,
  repeat_of: z.number().nullable(),
});

const Recorded = z.object({
  request: Request,
  result: z
    .object({ id: z.number(), occurrence_id: z.number(), replayed: z.boolean() })
    .optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

const duplicateSteps = [
  "the op key is the hash of source_story, text, area, project_id, kind, expected, evidence_refs, reporter, and repeat_of",
];

export function learningOpKey(fields: LearningIdentity): string {
  return `learning:${sha256Hex(canonicalJson(fields))}`;
}

export function learningIdentity(row: LearningRow): LearningIdentity {
  return {
    source_story: row.source_story,
    text: row.text,
    area: row.area,
    project_id: row.project_id,
    kind: row.kind,
    expected: normalizeExpected(row.expected),
    evidence_refs: sortedRefs(row.evidence_refs),
    reporter: row.reporter,
    repeat_of: row.repeat_of ?? null,
  };
}

function replayed(
  existing: Operation,
  opKey: string,
  request: LearningIdentity,
): Added {
  const ref = Recorded.safeParse(existing.result_ref);
  if (
    existing.intent !== "learning" ||
    !ref.success ||
    canonicalJson(ref.data.request) !== canonicalJson(request)
  )
    return refuse(
      "duplicate_op",
      `op key ${opKey} belongs to another intent or request`,
      duplicateSteps,
    );
  if (ref.data.result === undefined)
    return refuse(
      ref.data.code ?? "failed",
      ref.data.message ?? `op key ${opKey} was refused`,
      ref.data.nextSteps ?? [],
    );
  return {
    ok: true,
    id: ref.data.result.id,
    occurrence_id: ref.data.result.occurrence_id,
    replayed: true,
    opKey,
  };
}

export async function allowedKinds(
  tx: Repo,
  project: string | null,
): Promise<string[]> {
  const revision = await singleActive(
    tx,
    "policy",
    project === null ? "global" : "project",
    project ?? "",
  );
  return learningKinds(revision?.value);
}

export function unknownKind(
  kind: string,
  project: string | null,
  allowed: string[],
): Refused {
  const scope = project === null ? "global" : `project ${project}`;
  return refuse(
    "learning_kind_unknown",
    `learning kind ${kind} is not in the ${scope} policy's learning.kinds`,
    [
      `allowed kinds: ${allowed.join(", ")}`,
      "pod config set or pod config apply a policy Revision that adds the kind to learning.kinds, then a person activates it",
    ],
  );
}


async function target(
  tx: Repo,
  request: LearningIdentity,
): Promise<{ row: Learning | null } | Refused> {
  if (request.repeat_of !== null) {
    const row = await tx.getLearning(request.repeat_of);
    return row === null
      ? refuse(
          "schema_invalid",
          `--repeat-of ${request.repeat_of} names no learning`,
          ["repeat-of"],
        )
      : { row };
  }
  const candidates = await tx.listLearningsOfKind(request.kind);
  const ids = matchLearning(candidates, request);
  if (ids.length > 1)
    return refuse(
      "learning_match_ambiguous",
      `learning matches ${ids.length} rows: ${ids.join(", ")}`,
      ids.map(
        (id) =>
          `pod learning add FILE --area ${request.area} --kind ${request.kind} --repeat-of ${id}`,
      ),
    );
  const [id] = ids;
  return { row: candidates.find((row) => row.id === id) ?? null };
}

export async function writeLearning(
  tx: Repo,
  input: AddLearningInput,
): Promise<Added> {
  const request = learningIdentity(input.row);
  const opKey = learningOpKey(request);
  const existing = await tx.getOperation(opKey);
  if (existing !== null) return replayed(existing, opKey, request);
  const allowed = await allowedKinds(tx, request.project_id);
  if (!allowed.includes(request.kind))
    return unknownKind(request.kind, request.project_id, allowed);
  const found = await target(tx, request);
  if ("refusal" in found) return found;
  const matched = found.row;
  const now = input.now();
  const inserted = await tx.insertOperation({
    op_key: opKey,
    intent: "learning",
    owner_generation: 0,
    at: now,
    result_ref: Json.parse({ request }),
  });
  if (!inserted.created) return replayed(inserted.operation, opKey, request);
  const row =
    matched ??
    (await tx.insertLearning({
      source_story: request.source_story,
      evidence_refs: input.row.evidence_refs,
      text: request.text,
      adoption: input.row.adoption,
      area: input.row.area,
      project_id: request.project_id,
      kind: request.kind,
      expected: request.expected,
      theme: null,
      action_story: null,
      created_at: now,
      adoption_at: now,
    }));
  const occurrence = await tx.insertOccurrence({
    learning_id: row.id,
    story: request.source_story,
    occurred_on: now.toISOString().slice(0, 10),
    reporter: request.reporter,
    wording: request.text,
    evidence_id: evidenceId(input.row.evidence_refs),
    created_at: now,
  });
  if (matched !== null && occurrence.created) {
    const since = await tx.countOccurrencesSince(row.id, row.adoption_at);
    const adoption = reopenedAdoption(row, since, now);
    if (adoption !== row.adoption)
      await tx.setLearningAdoption(row.id, adoption, now);
  }
  await tx.appendEvent({
    type: "learning",
    ts: now,
    host: input.host,
    run_id: input.run_id ?? null,
    task_id: null,
    dispatch_id: null,
    op_key: opKey,
    payload: Json.parse({
      learning_id: row.id,
      occurrence_id: occurrence.id,
      kind: request.kind,
      source_story: request.source_story,
      area: request.area,
      project_id: request.project_id,
    }),
    source: Json.parse({ kind: "command", verb: input.verb ?? "learning add" }),
  });
  const result = { id: row.id, occurrence_id: occurrence.id, replayed: false };
  await tx.moveOperation(opKey, "done", Json.parse({ request, result }), now);
  return { ok: true, ...result, opKey };
}

export function addLearning(db: Db, input: AddLearningInput): Promise<Added> {
  return db.transaction((tx) => writeLearning(tx, input));
}
