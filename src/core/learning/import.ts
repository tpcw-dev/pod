import { z } from "zod";
import { sha256Hex } from "../config/canonical-json.ts";
import { Json } from "../domain/json.ts";
import type { ImportRow } from "../domain/learning.ts";
import type { Refusal } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";
import { allowedKinds, unknownKind } from "./add.ts";
import { normalizeExpected } from "./match.ts";

export interface ImportInput {
  rows: ImportRow[];
  host: string;
  now: () => Date;
}

export interface Imported {
  source_ref: string;
  id: number;
  replayed: boolean;
}

export type ImportOutcome =
  | { ok: true; rows: Imported[] }
  | { ok: false; refusal: Refusal };

export function importOpKey(sourceRef: string): string {
  return `learning:import:${sha256Hex(sourceRef)}`;
}

function byDate(row: ImportRow) {
  return [...row.occurrences].sort((a, b) =>
    a.occurred_on.localeCompare(b.occurred_on),
  );
}

const StoredImport = z.object({ id: z.number() });

async function storedId(tx: Repo, opKey: string): Promise<number | null> {
  const existing = await tx.getOperation(opKey);
  return existing === null ? null : StoredImport.parse(existing.result_ref).id;
}

async function writeRow(
  tx: Repo,
  row: ImportRow,
  input: ImportInput,
  now: Date,
): Promise<Imported> {
  const opKey = importOpKey(row.source_ref);
  const stored = await storedId(tx, opKey);
  if (stored !== null)
    return { source_ref: row.source_ref, id: stored, replayed: true };
  const ordered = byDate(row);
  const [earliest] = ordered;
  if (earliest === undefined)
    throw new Error(`import row ${row.source_ref} has no occurrence`);
  await tx.insertOperation({
    op_key: opKey,
    intent: "learning",
    owner_generation: 0,
    at: now,
    result_ref: Json.parse({ source_ref: row.source_ref }),
  });
  const learning = await tx.insertLearning({
    source_story: earliest.story,
    evidence_refs: row.occurrences.map((occurrence) => occurrence.evidence_id),
    text: row.text,
    adoption: row.adoption,
    area: row.area,
    project_id: row.project ?? null,
    kind: row.kind,
    expected: normalizeExpected(row.expected),
    theme: row.theme ?? null,
    action_story: row.action_story ?? null,
    created_at: now,
    adoption_at: now,
  });
  const occurrenceIds: number[] = [];
  for (const occurrence of ordered) {
    const written = await tx.insertOccurrence({
      learning_id: learning.id,
      story: occurrence.story,
      occurred_on: occurrence.occurred_on,
      reporter: occurrence.reporter,
      wording: occurrence.wording,
      evidence_id: occurrence.evidence_id,
      created_at: now,
    });
    occurrenceIds.push(written.id);
  }
  await tx.appendEvent({
    type: "learning",
    ts: now,
    host: input.host,
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: opKey,
    payload: Json.parse({
      learning_id: learning.id,
      kind: row.kind,
      source_ref: row.source_ref,
      occurrence_id: occurrenceIds[0],
      occurrence_ids: occurrenceIds,
    }),
    source: Json.parse({ kind: "command", verb: "learning import" }),
  });
  await tx.moveOperation(
    opKey,
    "done",
    Json.parse({ source_ref: row.source_ref, id: learning.id }),
    now,
  );
  return { source_ref: row.source_ref, id: learning.id, replayed: false };
}

export function importLearnings(
  db: Db,
  input: ImportInput,
): Promise<ImportOutcome> {
  return db.transaction(async (tx) => {
    for (const row of input.rows) {
      const project = row.project ?? null;
      const allowed = await allowedKinds(tx, project);
      if (!allowed.includes(row.kind)) {
        const refused = unknownKind(row.kind, project, allowed);
        return {
          ok: false,
          refusal: {
            ...refused.refusal,
            message: `${row.source_ref}: ${refused.refusal.message}`,
          },
        };
      }
    }
    const now = input.now();
    const rows: Imported[] = [];
    for (const row of input.rows) rows.push(await writeRow(tx, row, input, now));
    return { ok: true, rows };
  });
}
