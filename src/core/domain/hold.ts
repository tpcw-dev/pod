import { z } from "zod";
import type { Activity, Dispatch } from "./ledger.ts";
import { TaskState } from "./task-state.ts";

export const HoldPayload = z.looseObject({
  reason: z.string(),
  from: z.string().exactOptional(),
});
export type HoldPayload = z.infer<typeof HoldPayload>;

export type HeldDispatch = Pick<Dispatch, "activity" | "settlement">;

const fromDispatched: {
  to: TaskState;
  settlement?: readonly string[];
  activity?: readonly Activity[];
}[] = [
  { to: "dispatched", settlement: ["open"], activity: ["running"] },
  { to: "delivered", activity: ["waiting"] },
  { to: "delivered", settlement: ["done", "failed"] },
];

export function resumeTarget(
  from: string | undefined,
  latest: HeldDispatch | null,
): TaskState {
  const prior = TaskState.safeParse(from);
  if (!prior.success || prior.data === "hold") return "ready";
  if (prior.data !== "dispatched") return prior.data;
  if (latest === null) return "ready";
  const row = fromDispatched.find(
    (rule) =>
      (rule.settlement?.includes(latest.settlement) ?? true) &&
      (rule.activity?.includes(latest.activity) ?? true),
  );
  return row?.to ?? "blocked";
}

export function latestDispatch(rows: readonly Dispatch[], taskId: string) {
  let latest: Dispatch | null = null;
  for (const row of rows)
    if (
      row.task_id === taskId &&
      (latest === null ||
        row.created_at.getTime() > latest.created_at.getTime())
    )
      latest = row;
  return latest;
}
