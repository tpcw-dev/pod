import { z } from "zod";
import type { DecisionRow, DecisionState } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import { ManifestReference } from "../manifest/references.ts";
import type { Repo } from "../ports/db.ts";
import {
  recordOutcome,
  supersedeOpKey,
  type Recorded,
} from "../process/project.ts";

export const changeSpecStates: readonly string[] = [
  "pending",
  "ready",
  "hold",
  "dispatched",
  "delivered",
];

export const SupersedeRef = z.looseObject({
  kind: z.literal("supersede"),
  run_id: z.string(),
  decision_id: z.string(),
  task_id: z.string(),
  revision_id: z.string(),
  stop_request_id: z.string().nullable(),
  stop_unknown: z.boolean(),
  create_attempt: z.int().positive(),
  replacement_task_id: z.string().nullable(),
});
export type SupersedeRef = z.infer<typeof SupersedeRef>;

export async function specRevisionOf(
  tx: Repo,
  decision: DecisionRow,
): Promise<string> {
  const manifest = await tx.getManifest(decision.manifest_id);
  const references = z
    .array(ManifestReference)
    .parse(manifest?.references ?? []);
  const found = references.find((row) => row.source === "revision");
  if (found === undefined)
    throw new Error(
      `change_spec Decision ${decision.id} pins no Task spec Revision`,
    );
  return found.revision;
}

export async function applyEffect(
  tx: Repo,
  decision: DecisionRow,
  to: DecisionState,
  context: { at: Date; host: string },
): Promise<Recorded | null> {
  if (decision.task_id === null) return null;
  if (decision.effect === "change_spec") {
    if (to.kind !== "agreed") return null;
    const ref: SupersedeRef = {
      kind: "supersede",
      run_id: decision.run_id,
      decision_id: decision.id,
      task_id: decision.task_id,
      revision_id: await specRevisionOf(tx, decision),
      stop_request_id: null,
      stop_unknown: false,
      create_attempt: 1,
      replacement_task_id: null,
    };
    await tx.insertOperation({
      op_key: supersedeOpKey(decision.id),
      intent: "decide",
      owner_generation: 1,
      at: context.at,
      result_ref: Json.parse(ref),
    });
    return null;
  }
  if (to.kind !== "agreed" && to.kind !== "cancelled") return null;
  return recordOutcome(tx, {
    task: decision.task_id,
    outcome: to.kind,
    at: context.at,
    host: context.host,
    source: { kind: "decision", decision_id: decision.id },
  });
}
