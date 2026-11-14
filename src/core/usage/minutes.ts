import type { Activity, Dispatch } from "../domain/ledger.ts";
import type { UsageRecord } from "../domain/usage.ts";
import type { Repo } from "../ports/db.ts";
import { minuteMs } from "./pace.ts";

export interface Minutes {
  running_minutes: number | null;
  wall_minutes: number | null;
}

export interface ActivityChange {
  activity: Activity;
  at: Date;
}

function span(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / minuteMs;
}

function runningMinutes(
  createdAt: Date,
  settledAt: Date,
  history: readonly ActivityChange[],
): number | null {
  if (history[0]?.at.getTime() !== createdAt.getTime()) return null;
  let total = 0;
  history.forEach((change, index) => {
    if (change.activity !== "running") return;
    total += span(change.at, history[index + 1]?.at ?? settledAt);
  });
  return total;
}

export function dispatchMinutes(
  dispatch: Pick<Dispatch, "created_at" | "settled_at">,
  history: readonly ActivityChange[],
): Minutes {
  if (dispatch.settled_at === null)
    return { running_minutes: null, wall_minutes: null };
  return {
    running_minutes: runningMinutes(
      dispatch.created_at,
      dispatch.settled_at,
      history,
    ),
    wall_minutes: span(dispatch.created_at, dispatch.settled_at),
  };
}

export function sessionMinutes(
  record: Pick<UsageRecord, "first_at" | "through">,
): Minutes {
  const minutes = span(record.first_at, record.through);
  return { running_minutes: minutes, wall_minutes: minutes };
}

export async function readDispatchMinutes(
  db: Repo,
  dispatchId: string,
): Promise<Minutes | null> {
  const dispatch = await db.getDispatch(dispatchId);
  if (dispatch === null) return null;
  return dispatchMinutes(dispatch, await db.listDispatchActivity(dispatchId));
}
