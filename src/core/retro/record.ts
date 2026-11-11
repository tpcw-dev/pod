import { Json } from "../domain/json.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import {
  transcriptRef,
  type Ambiguous,
  type Finding,
  type RetroRecordResult,
  type RetroRecorded,
} from "../domain/retro.ts";
import { allowedKinds, unknownKind, writeLearning } from "../learning/add.ts";
import type { Db } from "../ports/db.ts";
import { dueRun, recordedRetro, retroOpKey } from "./due.ts";
import { retroStep } from "./run.ts";

export const retroKind = "tech";

export interface RetroRecordInput {
  run: string;
  findings: readonly Finding[];
  host: string;
  now: () => Date;
}

export type RetroRecordOutcome =
  { ok: true; result: RetroRecordResult; opKey: string } | Refused;

function badRef(index: number, ref: string, why: string): Refused {
  return refuse(
    "schema_invalid",
    `finding ${index}: evidence ref ${ref} ${why}`,
    [`findings.${index}.evidence_refs`],
  );
}

function checkRefs(
  findings: readonly Finding[],
  dispatchIds: ReadonlySet<string>,
): Refused | null {
  for (const [index, finding] of findings.entries())
    for (const ref of finding.evidence_refs) {
      if (!ref.startsWith("transcript:")) continue;
      const match = transcriptRef.exec(ref);
      if (match === null)
        return badRef(index, ref, "is not transcript:<dispatch_id>:<line>");
      if (!dispatchIds.has(match[1] ?? ""))
        return badRef(index, ref, "names no Dispatch of this Run");
    }
  return null;
}

export async function retroRecord(
  db: Db,
  input: RetroRecordInput,
): Promise<RetroRecordOutcome> {
  const due = await dueRun(db, input.run);
  if ("ok" in due) return due;
  const { run } = due;
  const opKey = retroOpKey(run.run_id);
  const done = (
    result: RetroRecorded,
    ambiguous: Ambiguous[],
    replayed: boolean,
  ) => ({
    ok: true as const,
    opKey,
    result: {
      run_id: run.run_id,
      learning_ids: result.learning_ids,
      occurrence_ids: result.occurrence_ids,
      ambiguous,
      complete: ambiguous.length === 0,
      replayed,
    },
  });

  const recorded = await recordedRetro(db, run.run_id);
  if (recorded !== null) return done(recorded, [], true);

  const dispatches = await db.listDispatches(run.run_id);
  const bad = checkRefs(
    input.findings,
    new Set(dispatches.map((row) => row.dispatch_id)),
  );
  if (bad !== null) return bad;
  const snapshot = await db.getSnapshot(run.run_id);
  const project = snapshot?.project ?? null;
  const allowed = await allowedKinds(db, project);
  if (!allowed.includes(retroKind))
    return unknownKind(retroKind, project, allowed);

  const learningIds: number[] = [];
  const occurrenceIds: number[] = [];
  const ambiguous: Ambiguous[] = [];
  for (const [index, finding] of input.findings.entries()) {
    const added = await db.transaction((tx) =>
      writeLearning(tx, {
        row: {
          source_story: run.story_external_id,
          evidence_refs: finding.evidence_refs,
          text: finding.text,
          adoption: "new",
          area: finding.area,
          project_id: project,
          kind: retroKind,
          expected: finding.expected ?? null,
          reporter: "retro",
          repeat_of: finding.repeat_of ?? null,
          wording: finding.wording,
        },
        host: input.host,
        now: input.now,
        run_id: run.run_id,
        verb: "retro record",
      }),
    );
    if (added.ok) {
      learningIds.push(added.id);
      occurrenceIds.push(added.occurrence_id);
    } else if (added.refusal.code === "learning_match_ambiguous")
      ambiguous.push({
        index,
        text: finding.text,
        message: added.refusal.message,
        nextSteps: [
          `set repeat_of on finding ${index} in FILE to one of the matched ids, then rerun pod retro record FILE --run ${run.run_id}`,
        ],
      });
    else return { ok: false, refusal: added.refusal };
  }
  const retroTask = (await db.listTasks(run.run_id)).find(
    (task) => task.step_id === retroStep,
  );
  const result: RetroRecorded = {
    learning_ids: learningIds,
    occurrence_ids: occurrenceIds,
    dispatch_id:
      retroTask === undefined
        ? null
        : (dispatches
            .filter((row) => row.task_id === retroTask.task_id)
            .at(-1)?.dispatch_id ?? null),
  };
  if (ambiguous.length > 0) return done(result, ambiguous, false);

  const created = await db.transaction(async (tx) => {
    const now = input.now();
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "retro",
      owner_generation: run.owner_generation,
      at: now,
    });
    if (!inserted.created) return false;
    await tx.appendEvent({
      type: "retro",
      ts: now,
      host: input.host,
      run_id: run.run_id,
      task_id: retroTask?.task_id ?? null,
      dispatch_id: result.dispatch_id,
      op_key: opKey,
      payload: Json.parse({ findings: input.findings.length, ...result }),
      source: { kind: "command", verb: "retro record" },
    });
    await tx.moveOperation(opKey, "done", Json.parse({ result }), now);
    return true;
  });
  if (created) return done(result, [], false);
  const stored = await recordedRetro(db, run.run_id);
  if (stored === null)
    return refuse("launch_unknown", `operation ${opKey} is not done`, [
      `pod retro record FILE --run ${run.run_id}`,
    ]);
  return done(stored, [], true);
}
