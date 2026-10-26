import { z } from "zod";
import type { Json } from "./json.ts";

export const eventTypes = [
  "start",
  "delivery",
  "receipt",
  "activation",
  "decision",
  "self_decision",
  "push",
  "pr",
  "deploy",
  "release",
  "takeover",
  "escalate",
  "cancel",
  "stop",
  "drain",
  "hold",
  "resume",
  "ignored",
  "unknown_launch",
  "learning",
] as const;
export const EventType = z.enum(eventTypes);
export type EventType = z.infer<typeof EventType>;

export const intents = [
  "run_create",
  "project",
  "dispatch",
  "retry",
  "decide_seat",
  "decide",
  "config_apply",
  "verdict",
  "hqa",
  "release",
  "takeover",
  "drain",
  "learning",
] as const;
export const Intent = z.enum(intents);
export type Intent = z.infer<typeof Intent>;

export const operationStatuses = [
  "pending",
  "unknown",
  "done",
  "refused",
] as const;
export const OperationStatus = z.enum(operationStatuses);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const operationMoves: Readonly<
  Record<OperationStatus, readonly OperationStatus[]>
> = {
  pending: ["unknown", "done", "refused"],
  unknown: ["done", "refused"],
  done: [],
  refused: [],
};

export function statusesMovingTo(to: OperationStatus): OperationStatus[] {
  return operationStatuses.filter((from) => operationMoves[from].includes(to));
}

export const Size = z.enum(["xs", "s", "m", "l", "xl"]);
export type Size = z.infer<typeof Size>;

export const RunState = z.enum(["active", "hold", "drained", "done"]);
export type RunState = z.infer<typeof RunState>;

export const ModelAttribution = z.enum(["receipt", "unknown"]);
export const Activity = z.enum(["running", "waiting", "settled"]);

export interface Story {
  provider: string;
  external_id: string;
  size: Size;
  stage: string;
  run_id: string | null;
  dependencies: Json;
  synced_at: Date;
}

export interface Run {
  run_id: string;
  story_provider: string;
  story_external_id: string;
  host: string;
  coordinator: string;
  owner_generation: number;
  snapshot_hash: string;
  state: RunState;
  created_at: Date;
}

export interface Task {
  task_id: string;
  run_id: string;
  step_id: string;
  lineage_id: string;
  role: string;
  deps: Json;
  spec_revision_id: string;
  state: string;
  created_at: Date;
}

export interface Dispatch {
  dispatch_id: string;
  task_id: string;
  run_id: string;
  seat: string;
  role: string;
  requested_launch: Json;
  effective_launch: Json | null;
  model_attribution: z.infer<typeof ModelAttribution>;
  retry_of: string | null;
  op_key: string;
  settlement: string;
  terminal_handle: string | null;
  created_at: Date;
  settled_at: Date | null;
  activity: z.infer<typeof Activity>;
  manifest_id: string | null;
}

export interface EvidenceManifest {
  id: string;
  run_id: string;
  task_id: string | null;
  decision_id: string | null;
  parent_id: string | null;
  references: Json;
  created_at: Date;
}

export interface NewEvent {
  type: EventType;
  ts: Date;
  host: string;
  run_id: string | null;
  task_id: string | null;
  dispatch_id: string | null;
  op_key: string | null;
  payload: Json;
  source: Json;
}

export interface Event extends NewEvent {
  id: number;
}

export interface NewOperation {
  op_key: string;
  intent: Intent;
  owner_generation: number;
  at: Date;
}

export interface Operation {
  op_key: string;
  intent: Intent;
  status: OperationStatus;
  owner_generation: number;
  result_ref: Json | null;
  created_at: Date;
  updated_at: Date;
}
