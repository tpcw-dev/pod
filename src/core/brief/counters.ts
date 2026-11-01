import type { BriefCounters } from "../domain/brief.ts";
import type { Json } from "../domain/json.ts";
import type { Dispatch, Event, Operation, Run, Task } from "../domain/ledger.ts";

export const HAND_FILLED_VERBS = [
  "verdict post",
  "hqa record",
  "config apply",
  "takeover",
  "check --resume",
] as const;

const recovery = new Set(["retry", "resume", "takeover", "release"]);
const handFilled = new Set<string>(HAND_FILLED_VERBS);

export function emptyCounters(): BriefCounters {
  return {
    coordinator_operations: 0,
    recovery_steps: 0,
    retries: 0,
    rework_tasks: 0,
    hand_filled: 0,
    fallback_launches: 0,
    model_mismatches: 0,
  };
}

export function sumCounters(rows: readonly BriefCounters[]): BriefCounters {
  const sum = emptyCounters();
  for (const row of rows) {
    sum.coordinator_operations += row.coordinator_operations;
    sum.recovery_steps += row.recovery_steps;
    sum.retries += row.retries;
    sum.rework_tasks += row.rework_tasks;
    sum.hand_filled += row.hand_filled;
    sum.fallback_launches += row.fallback_launches;
    sum.model_mismatches += row.model_mismatches;
  }
  return sum;
}

function commandVerb(source: Json): string | null {
  if (typeof source !== "object" || source === null || Array.isArray(source))
    return null;
  if (source["kind"] !== "command") return null;
  const verb = source["verb"];
  return typeof verb === "string" ? verb : null;
}

function lineagePosition(tasks: readonly Pick<Task, "task_id" | "lineage_id" | "created_at">[]) {
  const groups = new Map<string, typeof tasks[number][]>();
  for (const task of tasks) {
    const group = groups.get(task.lineage_id) ?? [];
    group.push(task);
    groups.set(task.lineage_id, group);
  }
  const above = new Set<string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => {
      const time = left.created_at.getTime() - right.created_at.getTime();
      if (time !== 0) return time;
      if (left.task_id < right.task_id) return -1;
      if (left.task_id > right.task_id) return 1;
      return 0;
    });
    for (const task of ordered.slice(1)) above.add(task.task_id);
  }
  return above;
}

export function countRun(
  run: Pick<Run, "run_id">,
  tasks: readonly Pick<Task, "task_id" | "lineage_id" | "created_at">[],
  dispatches: readonly (Pick<Dispatch, "run_id" | "op_key"> &
    Partial<
      Pick<
        Dispatch,
        "requested_launch" | "effective_launch" | "model_attribution"
      >
    >)[],
  events: readonly (Pick<Event, "run_id" | "type" | "op_key" | "source"> &
    Partial<Pick<Event, "payload">>)[],
  operations: readonly Pick<Operation, "op_key">[],
): BriefCounters {
  const runEvents = events.filter((row) => row.run_id === run.run_id);
  const keys = new Set<string>();
  for (const row of runEvents) {
    if (row.op_key !== null) keys.add(row.op_key);
  }
  for (const row of dispatches) {
    if (row.run_id === run.run_id) keys.add(row.op_key);
  }
  const rework = lineagePosition(tasks);
  return {
    coordinator_operations: operations.filter((row) => keys.has(row.op_key))
      .length,
    recovery_steps: runEvents.filter((row) => recovery.has(row.type)).length,
    retries: runEvents.filter((row) => row.type === "retry").length,
    rework_tasks: tasks.filter((row) => rework.has(row.task_id)).length,
    hand_filled: runEvents.filter((row) =>
      handFilled.has(commandVerb(row.source) ?? ""),
    ).length,
    fallback_launches: runEvents.filter(
      (row) => row.type === "start" && fallbackOf(row.payload ?? null) !== null,
    ).length,
    model_mismatches: dispatches.filter(
      (row) => row.run_id === run.run_id && modelMismatch(row),
    ).length,
  };
}

export function fallbackOf(payload: Json): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  const value = payload["fallback_of"];
  return typeof value === "string" ? value : null;
}

function modelOf(launch: Json | undefined): string | null {
  if (typeof launch !== "object" || launch === null || Array.isArray(launch))
    return null;
  const model = launch["model"];
  return typeof model === "string" ? model : null;
}

function modelMismatch(
  row: Partial<
    Pick<Dispatch, "requested_launch" | "effective_launch" | "model_attribution">
  >,
): boolean {
  if (row.model_attribution !== "receipt") return false;
  const requested = modelOf(row.requested_launch);
  const effective = modelOf(row.effective_launch);
  return requested !== null && effective !== null && requested !== effective;
}
