import { z } from "zod";

export interface OrcaPort {
  version(): Promise<OrcaVersion>
  runCreate(req: RunCreateRequest): Promise<Receipt<RunCreateResult>>
  runUse(req: RunUseRequest): Promise<Receipt<RunUseResult>>
  taskCreate(req: TaskCreateRequest): Promise<Receipt<TaskCreateResult>>
  workerStart(req: WorkerStartRequest): Promise<Receipt<WorkerStartResult>>
  workerStop(req: WorkerStopRequest): Promise<Receipt<WorkerStopResult>>
  workerRelease(req: WorkerReleaseRequest): Promise<Receipt<WorkerReleaseResult>>
  check(req: CheckRequest): Promise<Receipt<CheckResult>>      // includes ack
  send(req: SendRequest): Promise<Receipt<SendResult>>
  requestShow(req: RequestShowRequest): Promise<Receipt<RequestShowResult>>
  workerList(req: WorkerListRequest): Promise<Receipt<WorkerListResult>>
}

export interface Receipt<T> {
  verb: string
  exitCode: number
  result: T | null
  raw: unknown            // every field zod did not name, kept
  orcaVersion: string
}

export interface OrcaVersion {
  version: string;
}

export interface ReceiptRecord {
  verb: string;
  argv: string[];
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  orcaVersion: string;
}

export type ReceiptSink = (record: ReceiptRecord) => Promise<void>;

export const supportedOrcaRange = { min: "1.4.211", below: "1.5.0" } as const;

export function orcaRangeText(): string {
  return `>=${supportedOrcaRange.min} <${supportedOrcaRange.below}`;
}

export class OrcaVersionUnsupported extends Error {
  readonly range = orcaRangeText();
  constructor(readonly installed: string) {
    super(`Orca ${installed} is outside the supported range ${orcaRangeText()}`);
  }
}

export interface RunCreateRequest {
  objective: string;
  retryRequest?: string;
}

export interface RunUseRequest {
  run: string;
  retryRequest?: string;
}

export interface TaskCreateRequest {
  spec: string;
  run?: string;
  deps?: readonly string[];
  taskTitle?: string;
  retryRequest?: string;
}

export interface WorkerStartRequest {
  task?: string;
  spec?: string;
  run?: string;
  agent: string;
  model?: string;
  effort?: string;
  worktree?: string;
  deps?: readonly string[];
  retryOf?: string;
  retryRequest?: string;
}

export interface WorkerStopRequest {
  dispatch: string;
  retryRequest?: string;
}

export interface WorkerReleaseRequest {
  dispatch: string;
  retryRequest?: string;
}

export interface CheckRequest {
  run?: string;
  ack?: string;
  wait?: boolean;
  timeoutMs?: number;
}

export interface SendRequest {
  to: string;
  subject: string;
  body: string;
  run?: string;
  retryRequest?: string;
}

export interface RequestShowRequest {
  request: string;
}

export interface WorkerListRequest {
  run?: string;
}

export const RunCreateResult = z.looseObject({
  run: z.looseObject({ id: z.string().min(1) }),
});
export type RunCreateResult = z.infer<typeof RunCreateResult>;

export const TaskCreateResult = z.looseObject({
  task: z.looseObject({ id: z.string().min(1), status: z.string() }),
});
export type TaskCreateResult = z.infer<typeof TaskCreateResult>;

const Launch = z.looseObject({ model: z.string().nullish() }).nullish();

export const WorkerStartResult = z.looseObject({
  state: z.string(),
  dispatchId: z.string().nullish(),
  taskId: z.string().nullish(),
  terminalHandle: z.string().nullish(),
  launch: z
    .looseObject({ requested: Launch, effective: Launch })
    .nullish(),
  lastError: z.string().nullish(),
  failedStage: z.string().nullish(),
  requestId: z.string().nullish(),
});
export type WorkerStartResult = z.infer<typeof WorkerStartResult>;

export const RequestShowResult = z.looseObject({
  requestId: z.string(),
  state: z.enum(["completed", "pending", "absent"]),
});
export type RequestShowResult = z.infer<typeof RequestShowResult>;

export const LooseResult = z.looseObject({});
export type RunUseResult = z.infer<typeof LooseResult>;
export type WorkerStopResult = z.infer<typeof LooseResult>;
export type WorkerReleaseResult = z.infer<typeof LooseResult>;
export type CheckResult = z.infer<typeof LooseResult>;
export type SendResult = z.infer<typeof LooseResult>;
export type WorkerListResult = z.infer<typeof LooseResult>;
