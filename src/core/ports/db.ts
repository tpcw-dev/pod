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
  Adoption,
  Learning,
  LearningFilter,
  NewLearning,
  NewOccurrence,
} from "../domain/learning.ts";
import type { BriefTree } from "../domain/brief.ts";
import type {
  DigestProposal,
  NewDigestProposal,
  Verdict,
} from "../domain/digest.ts";
import type {
  Decision,
  DecisionChange,
  DecisionRound,
  DecisionRow,
} from "../domain/decision.ts";
import type { StateScope } from "../domain/state.ts";
import type { TaskState } from "../domain/task-state.ts";
import type {
  Activity,
  Dispatch,
  Event,
  EventType,
  GateReceipt,
  NewGateReceipt,
  EvidenceManifest,
  TestResult,
  NewEvent,
  NewOperation,
  Operation,
  OperationStatus,
  Run,
  RunState,
  NewOutboxRow,
  NewUsageObservation,
  OutboxRow,
  Story,
  StorySync,
  SyncState,
  Task,
  UsageObservation,
} from "../domain/ledger.ts";
import type { NewUsageRecord, UsageRecord } from "../domain/usage.ts";

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
  activeScopeRefs(kind: Kind, scope: Scope): Promise<string[]>;
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
  listOutboxParked(): Promise<OutboxRow[]>;
  ackOutbox(id: number, readback: Json): Promise<void>;
  failOutbox(id: number, error: string, opts?: { park: true }): Promise<void>;
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
  setRunCoordinator(
    runId: string,
    change: {
      generation: number;
      dispatch_id: string | null;
      coordinator: string;
    },
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
    change: {
      activity: Activity;
      settlement: string;
      settled_at: Date | null;
      at: Date;
    },
  ): Promise<boolean>;
  listDispatchActivity(
    dispatchId: string,
  ): Promise<{ activity: Activity; at: Date }[]>;
  hostActivities(host: string): Promise<Activity[]>;
  terminalSeat(host: string, handle: string): Promise<string | null>;
  unresolvedWorkers(host: string): Promise<string[]>;
  lockQuota(host: string): Promise<void>;
  insertLearning(row: NewLearning): Promise<Learning>;
  listLearnings(filter: LearningFilter): Promise<Learning[]>;
  getLearning(id: number): Promise<Learning | null>;
  listLearningsOfKind(kind: string): Promise<Learning[]>;
  insertOccurrence(
    row: NewOccurrence,
  ): Promise<{ id: number; created: boolean }>;
  countOccurrencesSince(learningId: number, since: Date): Promise<number>;
  setLearningAdoption(id: number, adoption: Adoption, at: Date): Promise<void>;
  setLearningTheme(id: number, theme: string): Promise<void>;
  setLearningActionStory(id: number, story: string): Promise<void>;
  insertDigestProposal(
    row: NewDigestProposal,
  ): Promise<{ proposal: DigestProposal; created: boolean }>;
  getDigestProposal(id: number): Promise<DigestProposal | null>;
  listOpenProposals(scope: string): Promise<DigestProposal[]>;
  listShownProposals(scope: string, day: string): Promise<DigestProposal[]>;
  showDigestProposal(id: number, day: string): Promise<void>;
  ruleDigestProposal(id: number, verdict: Verdict, at: Date): Promise<boolean>;
  failReceiptsSince(
    since: Date,
    project: string | null,
  ): Promise<GateReceipt[]>;
  insertManifest(
    row: EvidenceManifest,
  ): Promise<{ manifest: EvidenceManifest; created: boolean }>;
  getManifest(id: string): Promise<EvidenceManifest | null>;
  setManifestTests(id: string, tests: readonly TestResult[]): Promise<void>;
  readBrief(externalId: string | null): Promise<BriefTree>;
  insertUsageObservation(row: NewUsageObservation): Promise<UsageObservation>;
  latestUsageObservations(
    providers: readonly string[],
  ): Promise<UsageObservation[]>;
  insertUsageRecord(row: NewUsageRecord): Promise<UsageRecord>;
  usageWatermark(runtime: string, sessionId: string): Promise<Date | null>;
  dispatchByLocator(
    harness: string,
    sessionId: string,
  ): Promise<Dispatch | null>;
  hostStartedDispatches(host: string): Promise<Dispatch[]>;
  listDecisions(scope: StateScope): Promise<Decision[]>;
  insertDecision(row: DecisionRow): Promise<void>;
  getDecision(id: string): Promise<DecisionRow | null>;
  updateDecisionState(id: string, change: DecisionChange): Promise<boolean>;
  setDecisionSpent(id: string, spent: Json): Promise<void>;
  setDecisionManifest(id: string, from: string, to: string): Promise<boolean>;
  liveRunsPinningPolicyScope(scope: Scope, scopeRef: string): Promise<string[]>;
  insertDecisionRound(row: DecisionRound): Promise<void>;
  listDecisionRounds(decisionId: string): Promise<DecisionRound[]>;
  openDecisionsForRun(runId: string): Promise<DecisionRow[]>;
  listRunDecisions(runId: string): Promise<DecisionRow[]>;
  setDispatchActivity(
    dispatchId: string,
    activity: Activity,
    at: Date,
  ): Promise<boolean>;
  appendEvent(row: NewEvent): Promise<Event>;
  firstEvent(
    runId: string,
    types: readonly EventType[],
    options?: { runWide?: boolean },
  ): Promise<Event | null>;
  dispatchEvent(dispatchId: string, type: EventType): Promise<Event | null>;
  messageRecorded(runId: string, messageId: string): Promise<boolean>;
  commentSpent(commentId: string): Promise<boolean>;
  eventWith(
    type: EventType,
    payload: Record<string, Json>,
  ): Promise<Event | null>;
  latestEventWith(
    type: EventType,
    payload: Record<string, Json>,
  ): Promise<Event | null>;
  latestEvent(
    runId: string,
    type: EventType,
    options?: { taskId?: string; dispatchId?: string },
  ): Promise<Event | null>;
  listEvents(runId: string, type: EventType): Promise<Event[]>;
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
