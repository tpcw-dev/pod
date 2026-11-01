import { z } from "zod";
import type { Json } from "./json.ts";
import type { TaskState } from "./task-state.ts";

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
  "retry",
  "ignored",
  "unknown_launch",
  "learning",
  "outcome",
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
  pending: ["pending", "unknown", "done", "refused"],
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
export type Activity = z.infer<typeof Activity>;

export interface Story {
  provider: string;
  external_id: string;
  size: Size;
  stage: string;
  run_id: string | null;
  dependencies: Json;
  synced_at: Date;
  status: string | null;
  title: string | null;
  kickoff_line: string | null;
}

export interface StorySync {
  status: string;
  title: string;
  kickoff_line: string | null;
  synced_at: Date;
}

const OutboxStoryRef = z.strictObject({
  provider: z.string().min(1),
  external_id: z.string().min(1),
});

export const OutboxPayload = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("comment"),
    story: OutboxStoryRef,
    body: z.string().min(1),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("status"),
    story: OutboxStoryRef,
    status: z.string().min(1),
  }),
]);
export type OutboxPayload = z.infer<typeof OutboxPayload>;

export interface NewOutboxRow {
  op_key: string;
  target: "tracker";
  payload: OutboxPayload;
}

export interface OutboxRow {
  id: number;
  op_key: string;
  target: "tracker";
  payload: Json;
  tries: number;
  last_error: string | null;
  acked_at: Date | null;
  readback: Json | null;
}

export const SyncState = z.enum(["pending", "synced", "voided"]);
export type SyncState = z.infer<typeof SyncState>;

export const ReceiptOutcome = z.enum(["PASS", "FAIL"]);
export type ReceiptOutcome = z.infer<typeof ReceiptOutcome>;

export interface NewGateReceipt {
  gate_id: string;
  run_id: string;
  task_id: string;
  scope: string;
  spec_revision_id: string;
  candidate_sha: string;
  deployed_revision: string | null;
  keeper: string;
  outcome: ReceiptOutcome;
  source: Json;
  sync_state: SyncState;
  created_at: Date;
}

export interface GateReceipt extends NewGateReceipt {
  id: number;
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
  state: TaskState;
  rework_of: string | null;
  created_at: Date;
}

export interface Dispatch {
  dispatch_id: string;
  task_id: string | null;
  decision_id: string | null;
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
  activity: Activity;
  manifest_id: string | null;
}

export const TestResult = z.object({
  command: z.string().min(1),
  exit_code: z.int(),
  seconds: z.number().finite(),
  timeout_seconds: z.int().nullable(),
});
export type TestResult = z.infer<typeof TestResult>;
export const StoredTests = z.array(TestResult);

export interface EvidenceManifest {
  id: string;
  run_id: string;
  task_id: string | null;
  decision_id: string | null;
  parent_id: string | null;
  references: Json;
  tests: TestResult[] | null;
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
  result_ref?: Json | null;
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

export const Coverage = z.enum(["measured", "partial", "no_source"]);
export type Coverage = z.infer<typeof Coverage>;

export interface NewUsageObservation {
  provider: string;
  seat: string | null;
  window_start: Date;
  window_end: Date;
  value: string | null;
  coverage: Coverage;
  observed_at: Date;
  source: Json;
}

export interface UsageObservation extends NewUsageObservation {
  id: number;
}
