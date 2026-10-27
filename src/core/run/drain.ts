import { z } from "zod";
import { Json } from "../domain/json.ts";
import { RunState, type Operation, type Run } from "../domain/ledger.ts";
import { refuse, RefusalCode, type Refusal } from "../domain/outcome.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db, Repo } from "../ports/db.ts";

export interface DrainInput {
  run: string;
  generation: number;
  end: boolean;
  opKey: string | null;
  host: string;
  now: () => Date;
}

export const DrainResult = z.object({
  run_id: z.string(),
  state: RunState,
  drain_in_force: z.boolean(),
  ended: z.boolean(),
  recorded: z.boolean(),
  owner_generation: z.int(),
});
export type DrainResult = z.infer<typeof DrainResult>;

export type Drained =
  | { ok: true; result: DrainResult; opKey: string }
  | { ok: false; refusal: Refusal };

const Recorded = z.looseObject({
  request: z.looseObject({ ended: z.boolean() }),
  result: DrainResult.optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

async function freeKey(tx: Repo, run: Run, ended: boolean): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const opKey = derivedOpKey("drain", {
      run_id: run.run_id,
      ended: String(ended),
      attempt: String(attempt),
    });
    if ((await tx.getOperation(opKey)) === null) return opKey;
  }
}

function replayed(existing: Operation, opKey: string, ended: boolean): Drained {
  const ref = Recorded.safeParse(existing.result_ref);
  if (
    existing.intent !== "drain" ||
    !ref.success ||
    ref.data.request.ended !== ended
  )
    return refuse(
      "duplicate_op",
      `op key ${opKey} belongs to another intent or request`,
      ["pass a new --op-key"],
    );
  if (ref.data.result === undefined)
    return refuse(
      ref.data.code ?? "failed",
      ref.data.message ?? `op key ${opKey} was refused`,
      ref.data.nextSteps ?? [],
    );
  return { ok: true, result: ref.data.result, opKey };
}

function moved(state: RunState, ended: boolean): RunState {
  if (!ended && state === "active") return "drained";
  if (ended && state === "drained") return "active";
  return state;
}

export async function drain(db: Db, input: DrainInput): Promise<Drained> {
  return db.transaction(async (tx): Promise<Drained> => {
    const run = await tx.lockRun(input.run);
    if (run === null)
      return refuse("task_not_ready", `no Run ${input.run}`, ["pod brief"]);
    const ended = input.end;
    const request = { run_id: run.run_id, ended };
    const now = input.now();
    if (input.opKey !== null) {
      const existing = await tx.getOperation(input.opKey);
      if (existing !== null) return replayed(existing, input.opKey, ended);
    }
    const opKey = input.opKey ?? (await freeKey(tx, run, ended));
    if (input.generation !== run.owner_generation) {
      const refusal: Refusal = {
        code: "owner_generation_stale",
        message: `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
        nextSteps: [
          `pod takeover story:${run.story_external_id} if this session should own the Run`,
        ],
      };
      const inserted = await tx.insertOperation({
        op_key: opKey,
        intent: "drain",
        owner_generation: input.generation,
        at: now,
        result_ref: { request },
      });
      if (!inserted.created) return replayed(inserted.operation, opKey, ended);
      await tx.moveOperation(
        opKey,
        "refused",
        Json.parse({ request, ...refusal }),
        now,
      );
      return { ok: false, refusal };
    }
    const inForce = await drainInForce(tx, run.run_id);
    const result = (state: RunState, recorded: boolean): DrainResult => ({
      run_id: run.run_id,
      state,
      drain_in_force: recorded ? !ended : inForce,
      ended,
      recorded,
      owner_generation: run.owner_generation,
    });
    if (inForce !== ended)
      return { ok: true, result: result(run.state, false), opKey };
    const state = moved(run.state, ended);
    const done = result(state, true);
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "drain",
      owner_generation: input.generation,
      at: now,
      result_ref: { request },
    });
    if (!inserted.created) return replayed(inserted.operation, opKey, ended);
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, result: done }),
      now,
    );
    await tx.appendEvent({
      type: "drain",
      ts: now,
      host: input.host,
      run_id: run.run_id,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: { ended, op_key: opKey },
      source: { kind: "command", verb: "drain" },
    });
    if (state !== run.state) await tx.setRunState(run.run_id, state);
    return { ok: true, result: done, opKey };
  });
}
