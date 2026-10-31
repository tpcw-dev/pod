import type {
  Kind,
  Scope,
  ActivateInput,
  ActivateResult,
  Activation,
  ActivationKey,
  NewRevision,
  Revision,
  Snapshot,
} from "../domain/config.ts";
import type { Json } from "../domain/json.ts";
import type {
  Learning,
  LearningFilter,
  NewLearning,
} from "../domain/learning.ts";
import type { BriefTree } from "../domain/brief.ts";
import type { TaskState } from "../domain/task-state.ts";
import type {
  Activity,
  Dispatch,
  Event,
  EventType,
  GateReceipt,
  NewGateReceipt,
  EvidenceManifest,
  NewEvent,
  NewOperation,
  Operation,
  OperationStatus,
  Run,
  RunState,
  NewOutboxRow,
  OutboxRow,
  Story,
  StorySync,
  SyncState,
  Task,
} from "../domain/ledger.ts";

export interface Repo {
  insertRevision(
    row: NewRevision,
  ): Promise<{ revision: Revision; created: boolean }>;
  getRevision(id: string): Promise<Revision | null>;
  getRevisionByRef(
    kind: Kind,
    name: string,
    rev: number,
  ): Promise<Revision | null>;
  getActivation(key: ActivationKey): Promise<Activation | null>;
  listActivations(
    kind: Kind,
    scope: Scope,
    scopeRef: string,
  ): Promise<Activation[]>;
  activate(input: ActivateInput): Promise<ActivateResult>;
  insertSnapshot(row: Snapshot): Promise<void>;
  getSnapshot(runId: string): Promise<Snapshot | null>;
  upsertStory(row: Story): Promise<void>;
  getStory(provider: string, externalId: string): Promise<Story | null>;
  syncStory(
    provider: string,
    externalId: string,
    change: StorySync,
  ): Promise<void>;
  enqueueOutbox(row: NewOutboxRow): Promise<OutboxRow>;
  listOutboxPending(): Promise<OutboxRow[]>;
  ackOutbox(id: number, readback: Json): Promise<void>;
  failOutbox(id: number, error: string): Promise<void>;
  outboxByOpKey(opKey: string): Promise<OutboxRow | null>;
  insertGateReceipt(row: NewGateReceipt): Promise<GateReceipt>;
  listGateReceipts(runId: string): Promise<GateReceipt[]>;
  setGateReceiptSync(id: number, state: SyncState): Promise<void>;
  insertRun(row: Run): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  lockRun(runId: string): Promise<Run | null>;
  setRunState(runId: string, state: RunState): Promise<void>;
  advanceOwner(
    runId: string,
    change: { from: number; to: number; coordinator: string },
  ): Promise<boolean>;
  insertTask(row: Task): Promise<void>;
  getTask(taskId: string): Promise<Task | null>;
  listTasks(runId: string): Promise<Task[]>;
  setTaskState(taskId: string, state: TaskState): Promise<void>;
  setTaskDeps(taskId: string, deps: string[]): Promise<void>;
  insertDispatch(row: Dispatch): Promise<void>;
  getDispatch(dispatchId: string): Promise<Dispatch | null>;
  listDispatches(runId: string): Promise<Dispatch[]>;
  settleDispatch(
    dispatchId: string,
    change: { activity: Activity; settlement: string; settled_at: Date | null },
  ): Promise<boolean>;
  hostActivities(host: string): Promise<Activity[]>;
  lockQuota(host: string): Promise<void>;
  insertLearning(row: NewLearning): Promise<Learning>;
  listLearnings(filter: LearningFilter): Promise<Learning[]>;
  insertManifest(
    row: EvidenceManifest,
  ): Promise<{ manifest: EvidenceManifest; created: boolean }>;
  getManifest(id: string): Promise<EvidenceManifest | null>;
  readBrief(externalId: string | null): Promise<BriefTree>;
  appendEvent(row: NewEvent): Promise<Event>;
  firstEvent(
    runId: string,
    types: readonly EventType[],
    options?: { runWide?: boolean },
  ): Promise<Event | null>;
  dispatchEvent(dispatchId: string, type: EventType): Promise<Event | null>;
  messageRecorded(runId: string, messageId: string): Promise<boolean>;
  eventWith(
    type: EventType,
    payload: Record<string, string>,
  ): Promise<Event | null>;
  latestEvent(
    runId: string,
    type: EventType,
    options?: { taskId?: string },
  ): Promise<Event | null>;
  insertOperation(
    row: NewOperation,
  ): Promise<{ operation: Operation; created: boolean }>;
  getOperation(opKey: string): Promise<Operation | null>;
  launchReservations(
    intents: readonly string[],
  ): Promise<Pick<Operation, "op_key" | "intent" | "status" | "result_ref">[]>;
  listOperations(
    intents: readonly string[],
    statuses: readonly OperationStatus[],
  ): Promise<Operation[]>;
  moveOperation(
    opKey: string,
    to: OperationStatus,
    resultRef: Json | null,
    at: Date,
  ): Promise<Operation>;
}

export type BundleResult =
  { ok: true } | { ok: false; index: number; active: string | null };

export interface Db extends Repo {
  transaction<T>(work: (tx: Repo) => Promise<T>): Promise<T>;
  activateBundle(
    items: readonly Omit<ActivateInput, "bundle_id">[],
    bundleId: string,
  ): Promise<BundleResult>;
}
