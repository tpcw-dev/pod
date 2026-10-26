import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Operation } from "../domain/ledger.ts";
import { refuse, type Outcome } from "../domain/outcome.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import { ReleaseState, type OrcaPort } from "../ports/orca.ts";

export interface ReleaseInput {
  dispatch: string;
  generation: number;
  retain: string | null;
  host: string;
  now: () => Date;
}

export interface ReleaseResult {
  dispatch_id: string;
  state: ReleaseState;
  reason: string | null;
  owner_generation: number;
}

const finalStates: readonly ReleaseState[] = ["released", "already_released"];
const answered: readonly ReleaseState[] = [
  ...finalStates,
  "retained",
  "release_pending",
];

const Recorded = z.looseObject({
  state: ReleaseState,
  reason: z.string().nullable(),
});

type Key =
  | { kind: "final"; opKey: string; state: ReleaseState; reason: string | null }
  | { kind: "open"; opKey: string; operation: Operation };

async function releaseKey(
  db: Repo,
  scope: {
    run_id: string;
    dispatch_id: string;
    host: string;
    generation: number;
    at: Date;
  },
): Promise<Key> {
  for (let attempt = 1; ; attempt += 1) {
    const opKey = derivedOpKey("release", {
      run_id: scope.run_id,
      dispatch_id: scope.dispatch_id,
      attempt: String(attempt),
    });
    const existing = await db.getOperation(opKey);
    if (existing === null) {
      const { operation } = await db.insertOperation({
        op_key: opKey,
        intent: "release",
        owner_generation: scope.generation,
        at: scope.at,
        result_ref: { dispatch_id: scope.dispatch_id, host: scope.host },
      });
      return { kind: "open", opKey, operation };
    }
    if (existing.status !== "done")
      return { kind: "open", opKey, operation: existing };
    const recorded = Recorded.safeParse(existing.result_ref);
    if (recorded.success && finalStates.includes(recorded.data.state))
      return { kind: "final", opKey, ...recorded.data };
  }
}

function refused(message: string, nextSteps: string[]) {
  return refuse("release_refused", message, nextSteps);
}

export async function release(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: ReleaseInput,
): Promise<Outcome<ReleaseResult>> {
  const dispatch = await db.getDispatch(input.dispatch);
  if (dispatch === null)
    return refused(`no Dispatch ${input.dispatch}`, ["pod brief"]);
  const run = await db.getRun(dispatch.run_id);
  if (run === null) throw new Error(`Run ${dispatch.run_id} vanished`);
  if (run.owner_generation !== input.generation)
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );
  if (dispatch.settlement === "open" && input.retain === null)
    return refused(`Dispatch ${dispatch.dispatch_id} is not settled`, [
      "pod check",
      "--retain --reason",
    ]);
  const start = await db.dispatchEvent(dispatch.dispatch_id, "start");
  if (start?.host !== input.host)
    return refused(
      `Dispatch ${dispatch.dispatch_id} started on host ${start?.host ?? "unknown"}, not ${input.host}`,
      ["pod release on the host that started the Dispatch"],
    );
  const { version } = await orca.version();
  const result = (state: ReleaseState, reason: string | null) => ({
    dispatch_id: dispatch.dispatch_id,
    state,
    reason,
    owner_generation: input.generation,
  });

  const key = await db.transaction(async (tx) => {
    await tx.lockQuota(input.host);
    return releaseKey(tx, {
      run_id: run.run_id,
      dispatch_id: dispatch.dispatch_id,
      host: input.host,
      generation: input.generation,
      at: input.now(),
    });
  });
  if (key.kind === "final")
    return {
      ok: true,
      result: result(key.state, key.reason),
      opKey: key.opKey,
      orca: version,
    };
  const { opKey, operation } = key;

  log.at({ run_id: run.run_id, task_id: dispatch.task_id, op_key: opKey });
  const receipt = await orca.workerRelease({ dispatch: dispatch.dispatch_id });
  const state = receipt.result?.state;
  const at = input.now();
  if (
    receipt.exitCode === 0 &&
    state !== undefined &&
    answered.includes(state)
  ) {
    const finished = await db.transaction(async (tx) => {
      await tx.lockQuota(input.host);
      const current = await tx.getOperation(opKey);
      const recorded = Recorded.safeParse(current?.result_ref);
      if (current?.status === "done" && recorded.success) return recorded.data;
      await tx.moveOperation(
        opKey,
        "done",
        Json.parse({
          dispatch_id: dispatch.dispatch_id,
          state,
          reason: input.retain,
        }),
        at,
      );
      await tx.appendEvent({
        type: "release",
        ts: at,
        host: input.host,
        run_id: run.run_id,
        task_id: dispatch.task_id,
        dispatch_id: dispatch.dispatch_id,
        op_key: opKey,
        payload: { state, reason: input.retain, op_key: opKey },
        source: { kind: "command", verb: "release" },
      });
      return { state, reason: input.retain };
    });
    return {
      ok: true,
      result: result(finished.state, finished.reason),
      opKey,
      orca: version,
    };
  }
  if (operation.status === "pending")
    await db.transaction(async (tx) => {
      await tx.lockQuota(input.host);
      if ((await tx.getOperation(opKey))?.status !== "pending") return;
      await tx.moveOperation(
        opKey,
        "unknown",
        Json.parse({
          dispatch_id: dispatch.dispatch_id,
          state: state ?? null,
          exit_code: receipt.exitCode,
        }),
        at,
      );
    });
  return refuse(
    "failed",
    `worker-release for Dispatch ${dispatch.dispatch_id} answered ${state ?? `exit ${receipt.exitCode}`}`,
    [
      `pod release --dispatch ${dispatch.dispatch_id} --generation ${input.generation}`,
    ],
  );
}
