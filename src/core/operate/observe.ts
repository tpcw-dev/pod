import { checkObserve } from "../check/check.ts";
import { hostSlots } from "../config/host.ts";
import { Json } from "../domain/json.ts";
import { observedStates } from "./close-candidates.ts";
import type { OperatePorts } from "./ports.ts";
import type { StepContext, StepResult } from "./tick.ts";

export async function observeStep(
  ports: OperatePorts,
  ctx: Pick<StepContext, "db" | "host" | "writer" | "now">,
): Promise<StepResult> {
  const { db } = ctx;
  const capacity = await hostSlots(db, ctx.writer);
  const runs: Json[] = [];
  let failed = false;
  for (const run of await db.listHostRuns(ctx.host, observedStates)) {
    try {
      const pass = await checkObserve(
        db,
        ports.orca,
        ports.tracker,
        ports.log,
        {
          run: run.run_id,
          host: ctx.writer,
          capacity,
          now: () => ctx.now,
          leaseSeconds: ports.leaseSeconds,
        },
      );
      if (!pass.ok) {
        failed = true;
        runs.push({
          run_id: run.run_id,
          result: pass.refusal.code,
          message: pass.refusal.message,
        });
        continue;
      }
      runs.push(
        Json.parse({
          run_id: run.run_id,
          result: "ok",
          reconciled: pass.result.reconciled,
          unknown_workers: pass.result.unknown_workers,
          nextSteps: pass.result.nextSteps,
        }),
      );
    } catch (error) {
      failed = true;
      runs.push({
        run_id: run.run_id,
        result: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { result: failed ? "failed" : "ok", detail: { runs } };
}
