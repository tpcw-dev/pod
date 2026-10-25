import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const config = pgSchema("config");

export const revision = config.table(
  "revision",
  {
    id: text("id").primaryKey(),
    parent: text("parent"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    rev: integer("rev").notNull(),
    scope: text("scope").notNull(),
    scopeRef: text("scope_ref").notNull().default(""),
    value: jsonb("value").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.parent], foreignColumns: [t.id] }),
    check(
      "revision_kind_check",
      sql`${t.kind} in ('crew', 'process', 'policy', 'task')`,
    ),
    check(
      "revision_scope_check",
      sql`${t.scope} in ('global', 'project', 'host', 'run')`,
    ),
    unique().on(t.kind, t.name, t.rev),
  ],
);

export const activation = config.table(
  "activation",
  {
    scope: text("scope").notNull(),
    scopeRef: text("scope_ref").notNull().default(""),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => revision.id),
    bundleId: text("bundle_id"),
    activatedBy: text("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
    previousRevisionId: text("previous_revision_id").references(
      () => revision.id,
    ),
  },
  (t) => [primaryKey({ columns: [t.scope, t.scopeRef, t.kind, t.name] })],
);

export const snapshot = config.table("snapshot", {
  runId: text("run_id").primaryKey(),
  crewRevisionId: text("crew_revision_id")
    .notNull()
    .references(() => revision.id),
  processRevisionId: text("process_revision_id")
    .notNull()
    .references(() => revision.id),
  policyRevisionId: text("policy_revision_id")
    .notNull()
    .references(() => revision.id),
  effectiveGateMap: jsonb("effective_gate_map").notNull(),
  hash: text("hash").notNull(),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull(),
});
