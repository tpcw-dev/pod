import type { Revision } from "../domain/config.ts";
import type { Task } from "../domain/ledger.ts";
import { ProcessValue } from "./schema.ts";

const settled = new Set(["passed", "failed", "done", "superseded"]);

export function waitingOn(
  process: Pick<Revision, "value"> | null,
  task: Pick<Task, "step_id" | "state">,
  open?: { id: string; state: string },
): string | null {
  if (process === null || settled.has(task.state)) return null;
  const parsed = ProcessValue.safeParse(process.value);
  if (!parsed.success) return null;
  const step = parsed.data.steps.find((other) => other.id === task.step_id);
  if (step === undefined) return null;
  if (step.decision !== undefined && step.gate !== undefined) return null;
  if (step.decision !== undefined && open !== undefined)
    return `decision ${open.id} ${open.state.replace(":", " ")}`;
  if (step.decision !== undefined) return `decision ${step.decision}`;
  if (step.gate !== undefined) return `gate ${step.gate}`;
  return null;
}
