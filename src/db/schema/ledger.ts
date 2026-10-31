import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { revision } from "./config.ts";

export const ledger = pgSchema("ledger");

export const story = ledger.table(
  "story",
  {
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    size: text("size").notNull(),
    stage: text("stage").notNull(),
    runId: text("run_id"),
    dependencies: jsonb("dependencies").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    status: text("status"),
    title: text("title"),
    kickoffLine: text("kickoff_line"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalId] }),
    check("story_size_check", sql`${t.size} in ('xs', 's', 'm', 'l', 'xl')`),
  ],
);

export const run = ledger.table(
  "run",
  {
    runId: text("run_id").primaryKey(),
    storyProvider: text("story_provider").notNull(),
    storyExternalId: text("story_external_id").notNull(),
    host: text("host").notNull(),
    coordinator: text("coordinator").notNull(),
    ownerGeneration: integer("owner_generation").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "run_state_check",
      sql`${t.state} in ('active', 'hold', 'drained', 'done')`,
    ),
    foreignKey({
      columns: [t.storyProvider, t.storyExternalId],
      foreignColumns: [story.provider, story.externalId],
    }),
  ],
);

export const task = ledger.table(
  "task",
  {
    taskId: text("task_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
    stepId: text("step_id").notNull(),
    lineageId: text("lineage_id").notNull(),
    role: text("role").notNull(),
    deps: jsonb("deps").notNull(),
    specRevisionId: text("spec_revision_id")
      .notNull()
      .references(() => revision.id),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    reworkOf: text("rework_of"),
  },
  (t) => [
    foreignKey({ columns: [t.reworkOf], foreignColumns: [t.taskId] }),
    check(
      "task_state_check",
      sql`${t.state} in ('pending', 'ready', 'dispatched', 'delivered', 'passed', 'failed', 'blocked', 'hold', 'done', 'superseded')`,
    ),
  ],
);

export const evidenceManifest = ledger.table(
  "evidence_manifest",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
    taskId: text("task_id").references(() => task.taskId),
    decisionId: text("decision_id"),
    parentId: text("parent_id"),
    references: jsonb("references").notNull(),
    tests: jsonb("tests"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [foreignKey({ columns: [t.parentId], foreignColumns: [t.id] })],
);

export const learning = ledger.table(
  "learning",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceStory: text("source_story").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull(),
    text: text("text").notNull(),
    adoption: text("adoption").notNull(),
    area: text("area").notNull(),
    projectId: text("project_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "learning_adoption_check",
      sql`${t.adoption} in ('new', 'adopted', 'rejected')`,
    ),
    check(
      "learning_area_check",
      sql`${t.area} in ('product', 'design', 'impl', 'process')`,
    ),
  ],
);

export const operation = ledger.table(
  "operation",
  {
    opKey: text("op_key").primaryKey(),
    intent: text("intent").notNull(),
    status: text("status").notNull(),
    ownerGeneration: integer("owner_generation").notNull(),
    resultRef: jsonb("result_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "operation_intent_check",
      sql`${t.intent} in ('run_create', 'project', 'dispatch', 'retry', 'decide_seat', 'decide', 'config_apply', 'verdict', 'hqa', 'release', 'takeover', 'drain', 'learning')`,
    ),
    check(
      "operation_status_check",
      sql`${t.status} in ('pending', 'unknown', 'done', 'refused')`,
    ),
  ],
);

export const dispatch = ledger.table(
  "dispatch",
  {
    dispatchId: text("dispatch_id").primaryKey(),
    taskId: text("task_id").references(() => task.taskId),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
    decisionId: text("decision_id").references(() => decision.id),
    seat: text("seat").notNull(),
    role: text("role").notNull(),
    requestedLaunch: jsonb("requested_launch").notNull(),
    effectiveLaunch: jsonb("effective_launch"),
    modelAttribution: text("model_attribution").notNull(),
    retryOf: text("retry_of"),
    opKey: text("op_key")
      .notNull()
      .references(() => operation.opKey),
    settlement: text("settlement").notNull(),
    terminalHandle: text("terminal_handle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    activity: text("activity").notNull(),
    manifestId: text("manifest_id").references(() => evidenceManifest.id),
    executionBackend: text("execution_backend"),
    ownerHost: text("owner_host"),
    externalExecutionId: text("external_execution_id"),
    authRef: text("auth_ref"),
    outputRef: text("output_ref"),
  },
  (t) => [
    foreignKey({ columns: [t.retryOf], foreignColumns: [t.dispatchId] }),
    check(
      "dispatch_model_attribution_check",
      sql`${t.modelAttribution} in ('receipt', 'unknown')`,
    ),
    check(
      "dispatch_activity_check",
      sql`${t.activity} in ('running', 'waiting', 'settled')`,
    ),
    check(
      "dispatch_owner_check",
      sql`(${t.taskId} is null) = (${t.decisionId} is not null)`,
    ),
  ],
);

export const decision = ledger.table(
  "decision",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
    taskId: text("task_id").references(() => task.taskId),
    category: text("category").notNull(),
    effect: text("effect").notNull(),
    question: text("question").notNull(),
    options: jsonb("options").notNull(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => evidenceManifest.id),
    state: text("state").notNull(),
    outcome: jsonb("outcome"),
    reason: text("reason"),
    binding: text("binding").notNull(),
    budget: jsonb("budget").notNull(),
    spent: jsonb("spent").notNull(),
    supersedesDecisionId: text("supersedes_decision_id"),
    adoption: text("adoption").notNull().default("pending"),
    adoptionEvidence: jsonb("adoption_evidence").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.supersedesDecisionId],
      foreignColumns: [t.id],
    }),
    check(
      "decision_effect_check",
      sql`${t.effect} in ('accept_plan', 'change_spec')`,
    ),
    check(
      "decision_state_check",
      sql`${t.state} in ('requested', 'round:1', 'round:2', 'round:3', 'agreed', 'needs_human', 'cancelled')`,
    ),
    check(
      "decision_reason_check",
      sql`${t.reason} in ('policy-required', 'disagreement', 'context-missing', 'runtime-failure', 'agreed', 'cancelled', 'denied')`,
    ),
    check("decision_binding_check", sql`${t.binding} = 'run'`),
    check(
      "decision_adoption_check",
      sql`${t.adoption} in ('pending', 'adopted', 'reworked', 'reversed')`,
    ),
    uniqueIndex("decision_open_task_idx")
      .on(t.taskId)
      .where(
        sql`${t.state} in ('requested', 'round:1', 'round:2', 'round:3')`,
      ),
  ],
);

export const decisionRound = ledger.table(
  "decision_round",
  {
    decisionId: text("decision_id")
      .notNull()
      .references(() => decision.id),
    round: integer("round").notNull(),
    deciderDispatchId: text("decider_dispatch_id")
      .notNull()
      .references(() => dispatch.dispatchId),
    auditorDispatchId: text("auditor_dispatch_id")
      .notNull()
      .references(() => dispatch.dispatchId),
    proposal: jsonb("proposal").notNull(),
    audit: jsonb("audit").notNull(),
    stance: text("stance").notNull(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => evidenceManifest.id),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.round] }),
    check("decision_round_round_check", sql`${t.round} between 1 and 3`),
    check(
      "decision_round_stance_check",
      sql`${t.stance} in ('agree', 'disagree', 'escalate')`,
    ),
  ],
);

export const event = ledger.table(
  "event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    host: text("host").notNull(),
    runId: text("run_id"),
    taskId: text("task_id"),
    dispatchId: text("dispatch_id"),
    opKey: text("op_key"),
    payload: jsonb("payload").notNull(),
    source: jsonb("source").notNull(),
  },
  (t) => [
    check(
      "event_type_check",
      sql`${t.type} in ('start', 'delivery', 'receipt', 'activation', 'decision', 'self_decision', 'push', 'pr', 'deploy', 'release', 'takeover', 'escalate', 'cancel', 'stop', 'drain', 'hold', 'resume', 'retry', 'ignored', 'unknown_launch', 'learning', 'outcome')`,
    ),
    index("event_run_ts").on(t.runId, t.ts),
  ],
);

export const outbox = ledger.table(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    opKey: text("op_key")
      .notNull()
      .references(() => operation.opKey),
    target: text("target").notNull(),
    payload: jsonb("payload").notNull(),
    tries: integer("tries").notNull().default(0),
    lastError: text("last_error"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    readback: jsonb("readback"),
  },
  (t) => [
    check("outbox_target_check", sql`${t.target} in ('tracker')`),
    index("outbox_pending_idx")
      .on(t.id)
      .where(sql`${t.ackedAt} is null`),
  ],
);

export const gateReceipt = ledger.table(
  "gate_receipt",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gateId: text("gate_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
    taskId: text("task_id")
      .notNull()
      .references(() => task.taskId),
    scope: text("scope").notNull(),
    specRevisionId: text("spec_revision_id")
      .notNull()
      .references(() => revision.id),
    candidateSha: text("candidate_sha").notNull(),
    deployedRevision: text("deployed_revision"),
    keeper: text("keeper").notNull(),
    outcome: text("outcome").notNull(),
    source: jsonb("source").notNull(),
    syncState: text("sync_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("gate_receipt_outcome_check", sql`${t.outcome} in ('PASS', 'FAIL')`),
    check(
      "gate_receipt_sync_state_check",
      sql`${t.syncState} in ('pending', 'synced', 'voided')`,
    ),
    index("gate_receipt_run_idx").on(t.runId),
  ],
);

export const usageObservation = ledger.table(
  "usage_observation",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    seat: text("seat"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    value: numeric("value"),
    coverage: text("coverage").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    source: jsonb("source").notNull(),
  },
  (t) => [
    check(
      "usage_observation_coverage_check",
      sql`${t.coverage} in ('measured', 'partial', 'no_source')`,
    ),
    index("usage_observation_provider_idx").on(t.provider, t.observedAt),
  ],
);
