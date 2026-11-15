import { z } from "zod";
import { recordStops } from "../check/check.ts";
import { listWorkers } from "../check/workers.ts";
import { hostSlots } from "../config/host.ts";
import { retry, retryPlan, retryReady } from "../dispatch/retry.ts";
import { Json } from "../domain/json.ts";
import type { Dispatch } from "../domain/ledger.ts";
import { refuse, type Outcome } from "../domain/outcome.ts";
import type { NeedsHumanLine } from "../domain/tick.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db } from "../ports/db.ts";
import type { WorkerRow } from "../ports/orca.ts";
import {
  findStalls,
  needsHumanLine,
  sortLines,
  type HostRun,
} from "./stall.ts";
import type { OperatePorts } from "./ports.ts";
import type { StepContext, StepResult } from "./tick.ts";

export interface AttentionPort {
  workers(runId: string): Promise<WorkerRow[] | null>;
  capacity: number | null;
  retry(
    dispatch: Dispatch,
    opKey: string,
    worktreePath: string,
  ): Promise<Outcome<unknown>>;
}

interface Retried {
  dispatch_id: string;
  op_key: string;
  ok: boolean;
  code: string | null;
}

/** A worker that sent its own report: the report waits in Orca for `pod check`. */
const reported = new Set(["succeeded", "failed"]);

/** A Dispatch Pod settled for its own reason, such as a supersede, is not a stall. */
const unsettledOrStopped = new Set(["open", "stopped"]);

const StoredRefusal = z.looseObject({ code: z.string() });

export function attentionOpKey(
  host: string,
  dispatchId: string,
  story: string,
): string {
  return derivedOpKey("tick", {
    host,
    step: "attention",
    subject: dispatchId,
    story,
  });
}

async function retryStopped(
  db: Db,
  port: AttentionPort,
  ctx: Pick<StepContext, "host" | "writer">,
  run: HostRun,
  dispatch: Dispatch,
): Promise<{ retried: Retried | null; line: NeedsHumanLine | null }> {
  const ended = (text: string) =>
    needsHumanLine("worker_ended", run, dispatch.created_at, text, {
      task_id: dispatch.task_id,
      dispatch_id: dispatch.dispatch_id,
    });
  if (dispatch.retry_of !== null)
    return {
      retried: null,
      line: ended(
        `Dispatch ${dispatch.dispatch_id} stopped with no delivery and is itself the retry of ${dispatch.retry_of}`,
      ),
    };
  const opKey = attentionOpKey(ctx.host, dispatch.dispatch_id, run.story);
  const stored = await db.getOperation(opKey);
  if (stored?.status === "done")
    return {
      retried: {
        dispatch_id: dispatch.dispatch_id,
        op_key: opKey,
        ok: true,
        code: null,
      },
      line: null,
    };
  if (
    stored !== null &&
    stored.status !== "pending" &&
    stored.status !== "unknown"
  ) {
    const code =
      StoredRefusal.safeParse(stored.result_ref).data?.code ?? stored.status;
    return {
      retried: null,
      line: ended(
        `Dispatch ${dispatch.dispatch_id} stopped with no delivery and its one retry ended ${code}`,
      ),
    };
  }
  const ready =
    stored === null
      ? await retryReady(db, dispatch.dispatch_id, ctx.writer, port.capacity)
      : await retryPlan(db, dispatch.dispatch_id, ctx.writer);
  if ("ok" in ready)
    return {
      retried: null,
      line: ended(
        `Dispatch ${dispatch.dispatch_id} stopped with no delivery and is not retried now: ${ready.refusal.code}`,
      ),
    };
  const outcome = await port.retry(dispatch, opKey, ready.worktreePath);
  const retried = {
    dispatch_id: dispatch.dispatch_id,
    op_key: opKey,
    ok: outcome.ok,
    code: outcome.ok ? null : outcome.refusal.code,
  };
  return {
    retried,
    line: outcome.ok
      ? null
      : ended(
          `Dispatch ${dispatch.dispatch_id} stopped with no delivery and its one retry ended ${outcome.refusal.code}`,
        ),
  };
}

/**
 * Lists every stall, escalation, and needs_human Decision of the tick's host,
 * and runs one `pod retry` for a stopped worker that never delivered.
 */
export async function attend(
  db: Db,
  port: AttentionPort,
  ctx: Pick<StepContext, "host" | "writer" | "now">,
): Promise<StepResult> {
  const stalls = await findStalls(db, ctx.host, ctx.now);
  let lines = stalls.lines;
  const retried: Retried[] = [];
  const unread: string[] = [];
  for (const run of stalls.runs) {
    const silent = stalls.silent.filter(
      (each) => each.run_id === run.run.run_id,
    );
    if (silent.length === 0 || run.run.state === "done") continue;
    const rows = await port.workers(run.run.run_id);
    if (rows === null) {
      unread.push(run.run.run_id);
      continue;
    }
    const states = new Map(
      rows.map((row) => [row.dispatchId, row.workerState]),
    );
    const stopped: Dispatch[] = [];
    for (const dispatch of silent) {
      const state = states.get(dispatch.dispatch_id);
      if (state === undefined) continue;
      const ended = state === "stopped" || reported.has(state);
      if (!ended) continue;
      lines = lines.filter(
        (line) =>
          line.kind !== "dispatch_silent" ||
          line.dispatch_id !== dispatch.dispatch_id,
      );
      if (state === "stopped") {
        if (unsettledOrStopped.has(dispatch.settlement)) stopped.push(dispatch);
      } else
        lines.push(
          needsHumanLine(
            "worker_ended",
            run,
            dispatch.created_at,
            `Dispatch ${dispatch.dispatch_id} worker ${state} with no delivery recorded; pod check has its report to read`,
            { task_id: dispatch.task_id, dispatch_id: dispatch.dispatch_id },
          ),
        );
    }
    if (stopped.length === 0) continue;
    await db.transaction(async (tx) => {
      const locked = await tx.lockRun(run.run.run_id);
      if (locked !== null)
        await recordStops(tx, locked, rows, {
          host: ctx.writer,
          now: () => ctx.now,
        });
    });
    for (const dispatch of stopped) {
      const found = await retryStopped(db, port, ctx, run, dispatch);
      if (found.retried !== null) retried.push(found.retried);
      if (found.line !== null) lines.push(found.line);
    }
  }
  const sorted = sortLines(lines);
  return {
    result: "ok",
    detail: Json.parse({ retried, unread, needs_human: sorted.length }),
    needs_human: sorted,
  };
}

export async function attentionStep(
  ports: OperatePorts,
  ctx: Pick<StepContext, "db" | "host" | "writer" | "now">,
): Promise<StepResult> {
  const { db } = ctx;
  const capacity = await hostSlots(db, ctx.writer);
  return attend(
    db,
    {
      workers: (runId) => listWorkers(ports.orca, runId),
      capacity,
      async retry(dispatch, opKey, worktreePath) {
        const run = await db.getRun(dispatch.run_id);
        if (run === null)
          return refuse("task_not_ready", `Run ${dispatch.run_id} vanished`, [
            "pod brief",
          ]);
        const generation = run.owner_generation;
        return retry(db, ports.orca, ports.log, {
          dispatch: dispatch.dispatch_id,
          generation,
          opKey,
          host: ctx.writer,
          capacity,
          gitStatus: ports.gitStatus(worktreePath),
          command: (key) =>
            `pod retry --dispatch ${dispatch.dispatch_id} --generation ${generation} --op-key ${key}`,
          now: () => ctx.now,
        });
      },
    },
    ctx,
  );
}
