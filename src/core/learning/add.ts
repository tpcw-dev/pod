import { z } from "zod";
import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import { Json } from "../domain/json.ts";
import {
  Area,
  type LearningIdentity,
  type NewLearning,
} from "../domain/learning.ts";
import type { Operation } from "../domain/ledger.ts";
import { refuse, RefusalCode, type Refusal } from "../domain/outcome.ts";
import type { Db } from "../ports/db.ts";

export interface AddLearningInput {
  row: Omit<NewLearning, "created_at">;
  host: string;
  now: () => Date;
}

export type Added =
  | { ok: true; id: number; replayed: boolean; opKey: string }
  | { ok: false; refusal: Refusal };

const Request = z.object({
  source_story: z.string(),
  text: z.string(),
  area: Area,
  project_id: z.string().nullable(),
});

const Recorded = z.object({
  request: Request,
  result: z.object({ id: z.number(), replayed: z.boolean() }).optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

const duplicateSteps = [
  "the op key is the hash of source_story, text, area, and project_id",
];

export function learningOpKey(fields: LearningIdentity): string {
  return `learning:${sha256Hex(canonicalJson(fields))}`;
}

function sameRequest(
  stored: z.infer<typeof Request>,
  request: LearningIdentity,
): boolean {
  return (
    stored.source_story === request.source_story &&
    stored.text === request.text &&
    stored.area === request.area &&
    stored.project_id === request.project_id
  );
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
    !sameRequest(ref.data.request, request)
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
  return { ok: true, id: ref.data.result.id, replayed: true, opKey };
}

export async function addLearning(
  db: Db,
  input: AddLearningInput,
): Promise<Added> {
  const request: LearningIdentity = {
    source_story: input.row.source_story,
    text: input.row.text,
    area: input.row.area,
    project_id: input.row.project_id,
  };
  const opKey = learningOpKey(request);
  return db.transaction(async (tx) => {
    const existing = await tx.getOperation(opKey);
    if (existing !== null) return replayed(existing, opKey, request);
    const now = input.now();
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "learning",
      owner_generation: 0,
      at: now,
      result_ref: Json.parse({ request }),
    });
    if (!inserted.created) return replayed(inserted.operation, opKey, request);
    const stored = await tx.insertLearning({ ...input.row, created_at: now });
    await tx.appendEvent({
      type: "learning",
      ts: now,
      host: input.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse({
        learning_id: stored.id,
        source_story: request.source_story,
        area: request.area,
        project_id: request.project_id,
      }),
      source: Json.parse({ kind: "command", verb: "learning add" }),
    });
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, result: { id: stored.id, replayed: false } }),
      now,
    );
    return { ok: true, id: stored.id, replayed: false, opKey };
  });
}
