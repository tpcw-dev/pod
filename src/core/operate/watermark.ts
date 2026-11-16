import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { EventType } from "../domain/ledger.ts";
import {
  MetaOutputRef,
  type MetaStepName,
  type Watermark,
} from "../domain/tick.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db, Repo } from "../ports/db.ts";

const Output = z.looseObject({ meta: MetaOutputRef });

/**
 * A step's watermark is the input upper bound cited by its newest verified
 * output for the scope. A `meta` ref that does not parse is skipped.
 */
export async function readWatermark(
  repo: Repo,
  output: EventType,
  step: MetaStepName,
  scope: string,
): Promise<Watermark | null> {
  const outputs = await repo.eventsWith(output, {
    meta: { step, scope, verified: true },
  });
  for (const each of [...outputs].reverse()) {
    const ref = Output.safeParse(each.payload).data?.meta;
    if (ref !== undefined) return ref.input;
  }
  return null;
}

export function metaStepOpKey(
  step: MetaStepName,
  scope: string,
  watermark: Watermark | null,
): string {
  return derivedOpKey("tick", {
    agenda: "meta",
    step,
    scope,
    watermark: watermark === null ? "none" : String(watermark.event_id),
  });
}

export interface VerifiedOutput {
  type: EventType;
  ts: Date;
  host: string;
  payload: Record<string, Json>;
  source: Json;
  ref: Omit<MetaOutputRef, "verified">;
  opKey: string;
  readback: () => Promise<boolean>;
}

export type OutputWritten =
  | { written: true; event_id: number; replayed: boolean }
  | { written: false; event_id: null; replayed: false };

/**
 * Appends a step's output event only after its readback succeeds. The op-key
 * is the step's, so a rerun of the same packet returns the stored event.
 */
export async function writeVerifiedOutput(
  db: Db,
  output: VerifiedOutput,
): Promise<OutputWritten> {
  if (!(await output.readback()))
    return { written: false, event_id: null, replayed: false };
  return db.transaction(async (tx) => {
    const { created } = await tx.insertOperation({
      op_key: output.opKey,
      intent: "tick",
      owner_generation: 0,
      at: output.ts,
      result_ref: null,
    });
    if (!created) {
      const stored = (
        await tx.eventsWith(output.type, {
          meta: { step: output.ref.step, scope: output.ref.scope },
        })
      ).find((each) => each.op_key === output.opKey);
      if (stored === undefined)
        throw new Error(
          `output ${output.opKey} has an operation and no output event`,
        );
      return { written: true, event_id: stored.id, replayed: true };
    }
    const meta: MetaOutputRef = { ...output.ref, verified: true };
    const appended = await tx.appendEvent({
      type: output.type,
      ts: output.ts,
      host: output.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: output.opKey,
      payload: Json.parse({ ...output.payload, meta }),
      source: output.source,
    });
    await tx.moveOperation(
      output.opKey,
      "done",
      { event_id: appended.id },
      output.ts,
    );
    return { written: true, event_id: appended.id, replayed: false };
  });
}
