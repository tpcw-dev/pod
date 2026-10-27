import { z } from "zod";

export interface OrcaPort {
  version(): Promise<OrcaVersion>
  runCreate(req: RunCreateRequest): Promise<Receipt<RunCreateResult>>
  runUse(req: RunUseRequest): Promise<Receipt<RunUseResult>>
  runShow(req: RunShowRequest): Promise<Receipt<RunShowResult>>
  taskCreate(req: TaskCreateRequest): Promise<Receipt<TaskCreateResult>>
  workerStart(req: WorkerStartRequest): Promise<Receipt<WorkerStartResult>>
  workerStop(req: WorkerStopRequest): Promise<Receipt<WorkerStopResult>>
  workerRelease(req: WorkerReleaseRequest): Promise<Receipt<WorkerReleaseResult>>
  check(req: CheckRequest): Promise<Receipt<CheckResult>>      // includes ack
  send(req: SendRequest): Promise<Receipt<SendResult>>
  requestShow(req: RequestShowRequest): Promise<Receipt<RequestShowResult>>
  workerList(req: WorkerListRequest): Promise<Receipt<WorkerListResult>>
  terminalShow(req: TerminalShowRequest): Promise<Receipt<TerminalShowResult>>
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
  from?: string;
  retryRequest?: string;
}

export interface RunShowRequest {
  run: string;
}

export interface TerminalShowRequest {
  terminal: string;
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

export const terminalStates = [
  "active",
  "reclaimable",
  "retained",
  "release_pending",
  "release_unknown",
  "released",
] as const;
export type TerminalState = (typeof terminalStates)[number];

export interface WorkerListRequest {
  run?: string;
  terminalState?: TerminalState;
  cursor?: string;
  limit?: number;
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
  effects: z
    .array(z.looseObject({ kind: z.string(), id: z.string().nullish() }))
    .nullish(),
});
export type WorkerStartResult = z.infer<typeof WorkerStartResult>;

export const RequestShowResult = z.looseObject({
  requestId: z.string(),
  state: z.enum(["completed", "pending", "absent"]),
});
export type RequestShowResult = z.infer<typeof RequestShowResult>;

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const Payload = z.preprocess(
  parseJsonText,
  z
    .looseObject({
      dispatchId: z.string().optional(),
      taskId: z.string().optional(),
      outcome: z.string().optional(),
    })
    .catch({}),
);

export const OrcaMessage = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  subject: z.string().nullish(),
  payload: Payload,
});
export type OrcaMessage = z.infer<typeof OrcaMessage>;

export const CheckResult = z.looseObject({
  deliveryId: z.string().nullable(),
  messages: z.array(OrcaMessage),
  acknowledged: z.string().nullish(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const WorkerRow = z.looseObject({
  dispatchId: z.string().min(1),
  taskId: z.string().nullish(),
  workerState: z.string(),
  terminalState: z.string().nullish(),
  resource: z.looseObject({ worktreeId: z.string().nullish() }).nullish(),
});
export type WorkerRow = z.infer<typeof WorkerRow>;

export const WorkerListResult = z.looseObject({
  workers: z.array(WorkerRow),
  page: z.looseObject({ nextCursor: z.string().nullish() }),
});
export type WorkerListResult = z.infer<typeof WorkerListResult>;

export const WorkerStopResult = z.looseObject({
  dispatchId: z.string(),
  state: z.string(),
});
export type WorkerStopResult = z.infer<typeof WorkerStopResult>;

export const ReleaseState = z.enum([
  "released",
  "already_released",
  "retained",
  "release_pending",
  "release_unknown",
]);
export type ReleaseState = z.infer<typeof ReleaseState>;

export const WorkerReleaseResult = z.looseObject({
  dispatchId: z.string(),
  state: ReleaseState,
});
export type WorkerReleaseResult = z.infer<typeof WorkerReleaseResult>;

const OrcaRun = z.looseObject({
  id: z.string().min(1),
  coordinator_handle: z.string().min(1),
  consumer_generation: z.int(),
});

export const RunShowResult = z.looseObject({ run: OrcaRun });
export type RunShowResult = z.infer<typeof RunShowResult>;

export const RunUseResult = RunShowResult;
export type RunUseResult = RunShowResult;

export const TerminalShowResult = z.looseObject({
  terminal: z.looseObject({
    handle: z.string(),
    connected: z.boolean(),
    exitCause: z.looseObject({}).nullish(),
  }),
});
export type TerminalShowResult = z.infer<typeof TerminalShowResult>;

export const LooseResult = z.looseObject({});
export type SendResult = z.infer<typeof LooseResult>;
