import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
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

export const task = ledger.table("task", {
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
});

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
    taskId: text("task_id")
      .notNull()
      .references(() => task.taskId),
    runId: text("run_id")
      .notNull()
      .references(() => run.runId),
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
      sql`${t.type} in ('start', 'delivery', 'receipt', 'activation', 'decision', 'self_decision', 'push', 'pr', 'deploy', 'release', 'takeover', 'escalate', 'cancel', 'stop', 'drain', 'hold', 'resume', 'ignored', 'unknown_launch', 'learning')`,
    ),
    index("event_run_ts").on(t.runId, t.ts),
  ],
);
