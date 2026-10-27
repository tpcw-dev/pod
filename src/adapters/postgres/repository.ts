import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  Kind,
  Scope,
  type ActivateInput,
  type ActivateResult,
  type Activation,
  type ActivationKey,
  type NewRevision,
  type Revision,
  type Snapshot,
} from "../../core/domain/config.ts";
import type { BriefRun, BriefTree } from "../../core/domain/brief.ts";
import { Json } from "../../core/domain/json.ts";
import {
  Activity,
  EventType,
  Intent,
  ModelAttribution,
  OperationStatus,
  RunState,
  Size,
  statusesMovingTo,
  type Dispatch,
  type EvidenceManifest,
  type Event,
  type NewEvent,
  type NewOperation,
  type Operation,
  type Run,
  type Story,
  type Task,
} from "../../core/domain/ledger.ts";
import type { BundleResult, Db, Repo } from "../../core/ports/db.ts";
import * as configSchema from "../../db/schema/config.ts";
import * as ledgerSchema from "../../db/schema/ledger.ts";

const { activation, revision, snapshot } = configSchema;
const { dispatch, event, evidenceManifest, operation, run, story, task } =
  ledgerSchema;

type Database = PostgresJsDatabase<Record<string, never>>;
type Executor = Pick<Database, "select" | "insert" | "update" | "execute">;

function json(value: unknown): Json {
  return Json.parse(value);
}

function jsonOrNull(value: unknown): Json | null {
  return value === null ? null : Json.parse(value);
}

function toRevision(row: typeof revision.$inferSelect): Revision {
  return {
    id: row.id,
    parent: row.parent,
    kind: Kind.parse(row.kind),
    name: row.name,
    schema_version: row.schemaVersion,
    rev: row.rev,
    scope: Scope.parse(row.scope),
    scope_ref: row.scopeRef,
    value: json(row.value),
    actor: row.actor,
    reason: row.reason,
    created_at: row.createdAt,
  };
}

function toActivation(row: typeof activation.$inferSelect): Activation {
  return {
    scope: Scope.parse(row.scope),
    scope_ref: row.scopeRef,
    kind: Kind.parse(row.kind),
    name: row.name,
    revision_id: row.revisionId,
    bundle_id: row.bundleId,
    activated_by: row.activatedBy,
    activated_at: row.activatedAt,
    previous_revision_id: row.previousRevisionId,
  };
}

function toEvent(row: typeof event.$inferSelect): Event {
  return {
    id: row.id,
    type: EventType.parse(row.type),
    ts: row.ts,
    host: row.host,
    run_id: row.runId,
    task_id: row.taskId,
    dispatch_id: row.dispatchId,
    op_key: row.opKey,
    payload: json(row.payload),
    source: json(row.source),
  };
}

function toManifest(
  row: typeof evidenceManifest.$inferSelect,
): EvidenceManifest {
  return {
    id: row.id,
    run_id: row.runId,
    task_id: row.taskId,
    decision_id: row.decisionId,
    parent_id: row.parentId,
    references: json(row.references),
    created_at: row.createdAt,
  };
}

function toRun(row: typeof run.$inferSelect): Run {
  return {
    run_id: row.runId,
    story_provider: row.storyProvider,
    story_external_id: row.storyExternalId,
    host: row.host,
    coordinator: row.coordinator,
    owner_generation: row.ownerGeneration,
    snapshot_hash: row.snapshotHash,
    state: RunState.parse(row.state),
    created_at: row.createdAt,
  };
}

function toTask(row: typeof task.$inferSelect): Task {
  return {
    task_id: row.taskId,
    run_id: row.runId,
    step_id: row.stepId,
    lineage_id: row.lineageId,
    role: row.role,
    deps: json(row.deps),
    spec_revision_id: row.specRevisionId,
    state: row.state,
    created_at: row.createdAt,
  };
}

function toDispatch(row: typeof dispatch.$inferSelect): Dispatch {
  return {
    dispatch_id: row.dispatchId,
    task_id: row.taskId,
    run_id: row.runId,
    seat: row.seat,
    role: row.role,
    requested_launch: json(row.requestedLaunch),
    effective_launch: jsonOrNull(row.effectiveLaunch),
    model_attribution: ModelAttribution.parse(row.modelAttribution),
    retry_of: row.retryOf,
    op_key: row.opKey,
    settlement: row.settlement,
    terminal_handle: row.terminalHandle,
    created_at: row.createdAt,
    settled_at: row.settledAt,
    activity: Activity.parse(row.activity),
    manifest_id: row.manifestId,
  };
}

function toOperation(row: typeof operation.$inferSelect): Operation {
  return {
    op_key: row.opKey,
    intent: Intent.parse(row.intent),
    status: OperationStatus.parse(row.status),
    owner_generation: row.ownerGeneration,
    result_ref: jsonOrNull(row.resultRef),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function activationWhere(key: ActivationKey) {
  return and(
    eq(activation.scope, key.scope),
    eq(activation.scopeRef, key.scope_ref),
    eq(activation.kind, key.kind),
    eq(activation.name, key.name),
  );
}

function makeRepo(x: Executor): Repo {
  const repo: Repo = {
    async insertRevision(row: NewRevision) {
      await x.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${row.kind}.${row.name}`}))`,
      );
      const existing = await repo.getRevision(row.id);
      if (existing !== null) return { revision: existing, created: false };
      const [top] = await x
        .select({ rev: max(revision.rev) })
        .from(revision)
        .where(and(eq(revision.kind, row.kind), eq(revision.name, row.name)));
      const [inserted] = await x
        .insert(revision)
        .values({
          id: row.id,
          parent: row.parent,
          kind: row.kind,
          name: row.name,
          schemaVersion: row.schema_version,
          rev: (top?.rev ?? 0) + 1,
          scope: row.scope,
          scopeRef: row.scope_ref,
          value: row.value,
          actor: row.actor,
          reason: row.reason,
        })
        .returning();
      if (inserted === undefined)
        throw new Error("revision insert returned no row");
      return { revision: toRevision(inserted), created: true };
    },

    async getRevision(id) {
      const [row] = await x.select().from(revision).where(eq(revision.id, id));
      return row === undefined ? null : toRevision(row);
    },

    async getRevisionByRef(kind, name, rev) {
      const [row] = await x
        .select()
        .from(revision)
        .where(
          and(
            eq(revision.kind, kind),
            eq(revision.name, name),
            eq(revision.rev, rev),
          ),
        );
      return row === undefined ? null : toRevision(row);
    },

    async getActivation(key) {
      const [row] = await x
        .select()
        .from(activation)
        .where(activationWhere(key));
      return row === undefined ? null : toActivation(row);
    },

    async listActivations(kind, scope, scopeRef) {
      const rows = await x
        .select()
        .from(activation)
        .where(
          and(
            eq(activation.kind, kind),
            eq(activation.scope, scope),
            eq(activation.scopeRef, scopeRef),
          ),
        )
        .orderBy(asc(activation.name));
      return rows.map(toActivation);
    },

    async activate(input: ActivateInput): Promise<ActivateResult> {
      if (input.expected === null) {
        const inserted = await x
          .insert(activation)
          .values({
            scope: input.scope,
            scopeRef: input.scope_ref,
            kind: input.kind,
            name: input.name,
            revisionId: input.revision_id,
            bundleId: input.bundle_id,
            activatedBy: input.activated_by,
            activatedAt: input.activated_at,
            previousRevisionId: null,
          })
          .onConflictDoNothing()
          .returning({ scope: activation.scope });
        if (inserted.length === 1) return { ok: true, previous: null };
      } else {
        const updated = await x
          .update(activation)
          .set({
            revisionId: input.revision_id,
            previousRevisionId: sql`${activation.revisionId}`,
            bundleId: input.bundle_id,
            activatedBy: input.activated_by,
            activatedAt: input.activated_at,
          })
          .where(
            and(
              activationWhere(input),
              eq(activation.revisionId, input.expected),
            ),
          )
          .returning({ previous: activation.previousRevisionId });
        const [row] = updated;
        if (row !== undefined) return { ok: true, previous: row.previous };
      }
      const current = await repo.getActivation(input);
      return { ok: false, active: current?.revision_id ?? null };
    },

    async insertSnapshot(row: Snapshot) {
      await x.insert(snapshot).values({
        runId: row.run_id,
        crewRevisionId: row.crew_revision_id,
        processRevisionId: row.process_revision_id,
        policyRevisionId: row.policy_revision_id,
        effectiveGateMap: row.effective_gate_map,
        hash: row.hash,
        pinnedAt: row.pinned_at,
      });
    },

    async getSnapshot(runId) {
      const [row] = await x
        .select()
        .from(snapshot)
        .where(eq(snapshot.runId, runId));
      if (row === undefined) return null;
      return {
        run_id: row.runId,
        crew_revision_id: row.crewRevisionId,
        process_revision_id: row.processRevisionId,
        policy_revision_id: row.policyRevisionId,
        effective_gate_map: json(row.effectiveGateMap),
        hash: row.hash,
        pinned_at: row.pinnedAt,
      };
    },

    async upsertStory(row: Story) {
      const values = {
        provider: row.provider,
        externalId: row.external_id,
        size: row.size,
        stage: row.stage,
        runId: row.run_id,
        dependencies: row.dependencies,
        syncedAt: row.synced_at,
      };
      await x
        .insert(story)
        .values(values)
        .onConflictDoUpdate({
          target: [story.provider, story.externalId],
          set: {
            size: values.size,
            stage: values.stage,
            runId: values.runId,
            dependencies: values.dependencies,
            syncedAt: values.syncedAt,
          },
        });
    },

    async getStory(provider, externalId) {
      const [row] = await x
        .select()
        .from(story)
        .where(
          and(eq(story.provider, provider), eq(story.externalId, externalId)),
        );
      if (row === undefined) return null;
      return {
        provider: row.provider,
        external_id: row.externalId,
        size: Size.parse(row.size),
        stage: row.stage,
        run_id: row.runId,
        dependencies: json(row.dependencies),
        synced_at: row.syncedAt,
      };
    },

    async insertRun(row: Run) {
      await x.insert(run).values({
        runId: row.run_id,
        storyProvider: row.story_provider,
        storyExternalId: row.story_external_id,
        host: row.host,
        coordinator: row.coordinator,
        ownerGeneration: row.owner_generation,
        snapshotHash: row.snapshot_hash,
        state: row.state,
        createdAt: row.created_at,
      });
    },

    async getRun(runId) {
      const [row] = await x.select().from(run).where(eq(run.runId, runId));
      return row === undefined ? null : toRun(row);
    },

    async lockRun(runId) {
      const [row] = await x
        .select()
        .from(run)
        .where(eq(run.runId, runId))
        .for("update");
      return row === undefined ? null : toRun(row);
    },

    async setRunState(runId, state) {
      await x.update(run).set({ state }).where(eq(run.runId, runId));
    },

    async advanceOwner(runId, change) {
      const rows = await x
        .update(run)
        .set({ ownerGeneration: change.to, coordinator: change.coordinator })
        .where(and(eq(run.runId, runId), eq(run.ownerGeneration, change.from)))
        .returning({ id: run.runId });
      return rows.length > 0;
    },

    async insertTask(row: Task) {
      await x.insert(task).values({
        taskId: row.task_id,
        runId: row.run_id,
        stepId: row.step_id,
        lineageId: row.lineage_id,
        role: row.role,
        deps: row.deps,
        specRevisionId: row.spec_revision_id,
        state: row.state,
        createdAt: row.created_at,
      });
    },

    async getTask(taskId) {
      const [row] = await x.select().from(task).where(eq(task.taskId, taskId));
      return row === undefined ? null : toTask(row);
    },

    async listTasks(runId) {
      const rows = await x
        .select()
        .from(task)
        .where(eq(task.runId, runId))
        .orderBy(asc(task.createdAt), asc(task.taskId));
      return rows.map(toTask);
    },

    async setTaskState(taskId, state) {
      await x.update(task).set({ state }).where(eq(task.taskId, taskId));
    },

    async insertDispatch(row: Dispatch) {
      await x.insert(dispatch).values({
        dispatchId: row.dispatch_id,
        taskId: row.task_id,
        runId: row.run_id,
        seat: row.seat,
        role: row.role,
        requestedLaunch: row.requested_launch,
        effectiveLaunch: row.effective_launch,
        modelAttribution: row.model_attribution,
        retryOf: row.retry_of,
        opKey: row.op_key,
        settlement: row.settlement,
        terminalHandle: row.terminal_handle,
        createdAt: row.created_at,
        settledAt: row.settled_at,
        activity: row.activity,
        manifestId: row.manifest_id,
      });
    },

    async getDispatch(dispatchId) {
      const [row] = await x
        .select()
        .from(dispatch)
        .where(eq(dispatch.dispatchId, dispatchId));
      return row === undefined ? null : toDispatch(row);
    },

    async listDispatches(runId) {
      const rows = await x
        .select()
        .from(dispatch)
        .where(eq(dispatch.runId, runId))
        .orderBy(asc(dispatch.dispatchId));
      return rows.map(toDispatch);
    },

    async settleDispatch(dispatchId, change) {
      const rows = await x
        .update(dispatch)
        .set({
          activity: change.activity,
          settlement: change.settlement,
          settledAt: change.settled_at,
        })
        .where(
          and(
            eq(dispatch.dispatchId, dispatchId),
            eq(dispatch.settlement, "open"),
          ),
        )
        .returning({ id: dispatch.dispatchId });
      return rows.length > 0;
    },

    async hostActivities(host) {
      const rows = await x
        .select({ activity: dispatch.activity })
        .from(dispatch)
        .innerJoin(run, eq(run.runId, dispatch.runId))
        .where(eq(run.host, host));
      return rows.map((row) => Activity.parse(row.activity));
    },

    async lockQuota(host) {
      await x.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`quota:${host}`}))`,
      );
    },

    async insertManifest(row: EvidenceManifest) {
      const existing = await repo.getManifest(row.id);
      if (existing !== null) return { manifest: existing, created: false };
      const inserted = await x
        .insert(evidenceManifest)
        .values({
          id: row.id,
          runId: row.run_id,
          taskId: row.task_id,
          decisionId: row.decision_id,
          parentId: row.parent_id,
          references: row.references,
          createdAt: row.created_at,
        })
        .onConflictDoNothing({ target: evidenceManifest.id })
        .returning();
      const [stored] = inserted;
      if (stored !== undefined)
        return { manifest: toManifest(stored), created: true };
      const raced = await repo.getManifest(row.id);
      if (raced === null) throw new Error("manifest insert returned no row");
      return { manifest: raced, created: false };
    },

    async getManifest(id) {
      const [row] = await x
        .select()
        .from(evidenceManifest)
        .where(eq(evidenceManifest.id, id));
      return row === undefined ? null : toManifest(row);
    },

    async readBrief(externalId) {
      const storyRows =
        externalId === null
          ? await x
              .select()
              .from(story)
              .orderBy(asc(story.provider), asc(story.externalId))
          : await x
              .select()
              .from(story)
              .where(eq(story.externalId, externalId))
              .orderBy(asc(story.provider), asc(story.externalId));
      const stories: BriefTree["stories"][number][] = [];
      for (const row of storyRows) {
        const storyRow: Story = {
          provider: row.provider,
          external_id: row.externalId,
          size: Size.parse(row.size),
          stage: row.stage,
          run_id: row.runId,
          dependencies: json(row.dependencies),
          synced_at: row.syncedAt,
        };
        const runRows = await x
          .select()
          .from(run)
          .where(
            and(
              eq(run.storyProvider, row.provider),
              eq(run.storyExternalId, row.externalId),
            ),
          )
          .orderBy(asc(run.runId));
        const runs: BriefRun[] = [];
        for (const runRow of runRows) {
          const snap = await repo.getSnapshot(runRow.runId);
          const taskRows = await x
            .select()
            .from(task)
            .where(eq(task.runId, runRow.runId))
            .orderBy(asc(task.taskId));
          const dispatchRows = await x
            .select()
            .from(dispatch)
            .where(eq(dispatch.runId, runRow.runId))
            .orderBy(asc(dispatch.dispatchId));
          runs.push({
            run: {
              run_id: runRow.runId,
              story_provider: runRow.storyProvider,
              story_external_id: runRow.storyExternalId,
              host: runRow.host,
              coordinator: runRow.coordinator,
              owner_generation: runRow.ownerGeneration,
              snapshot_hash: runRow.snapshotHash,
              state: RunState.parse(runRow.state),
              created_at: runRow.createdAt,
            },
            snapshot:
              snap === null
                ? null
                : {
                    hash: snap.hash,
                    pinned_at: snap.pinned_at,
                    crew_revision_id: snap.crew_revision_id,
                    process_revision_id: snap.process_revision_id,
                    policy_revision_id: snap.policy_revision_id,
                    crew: await repo.getRevision(snap.crew_revision_id),
                    process: await repo.getRevision(snap.process_revision_id),
                    policy: await repo.getRevision(snap.policy_revision_id),
                  },
            tasks: taskRows.map(toTask),
            dispatches: dispatchRows.map(toDispatch),
          });
        }
        stories.push({ story: storyRow, runs });
      }
      return { stories };
    },

    async appendEvent(row: NewEvent) {
      const [inserted] = await x
        .insert(event)
        .values({
          type: row.type,
          ts: row.ts,
          host: row.host,
          runId: row.run_id,
          taskId: row.task_id,
          dispatchId: row.dispatch_id,
          opKey: row.op_key,
          payload: row.payload,
          source: row.source,
        })
        .returning();
      if (inserted === undefined)
        throw new Error("event insert returned no row");
      return toEvent(inserted);
    },

    async firstEvent(runId, types, options) {
      const [row] = await x
        .select()
        .from(event)
        .where(
          and(
            eq(event.runId, runId),
            inArray(event.type, [...types]),
            options?.runWide === true ? isNull(event.dispatchId) : undefined,
          ),
        )
        .orderBy(asc(event.ts), asc(event.id))
        .limit(1);
      return row === undefined ? null : toEvent(row);
    },

    async dispatchEvent(dispatchId, type) {
      const [row] = await x
        .select()
        .from(event)
        .where(and(eq(event.dispatchId, dispatchId), eq(event.type, type)))
        .orderBy(asc(event.ts), asc(event.id))
        .limit(1);
      return row === undefined ? null : toEvent(row);
    },

    async messageRecorded(runId, messageId) {
      const rows = await x
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.runId, runId),
            sql`${event.payload}->>'message_id' = ${messageId}`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async latestEvent(runId, type, options) {
      const [row] = await x
        .select()
        .from(event)
        .where(
          and(
            eq(event.runId, runId),
            eq(event.type, type),
            options?.taskId === undefined
              ? undefined
              : eq(event.taskId, options.taskId),
          ),
        )
        .orderBy(desc(event.id))
        .limit(1);
      return row === undefined ? null : toEvent(row);
    },

    async insertOperation(row: NewOperation) {
      const inserted = await x
        .insert(operation)
        .values({
          opKey: row.op_key,
          intent: row.intent,
          status: "pending",
          ownerGeneration: row.owner_generation,
          resultRef: row.result_ref ?? null,
          createdAt: row.at,
          updatedAt: row.at,
        })
        .onConflictDoNothing()
        .returning();
      const [created] = inserted;
      if (created !== undefined)
        return { operation: toOperation(created), created: true };
      const existing = await repo.getOperation(row.op_key);
      if (existing === null)
        throw new Error(`operation ${row.op_key} vanished`);
      return { operation: existing, created: false };
    },

    async getOperation(opKey) {
      const [row] = await x
        .select()
        .from(operation)
        .where(eq(operation.opKey, opKey));
      return row === undefined ? null : toOperation(row);
    },

    async launchReservations(intents) {
      return x
        .select({
          op_key: operation.opKey,
          intent: operation.intent,
          status: operation.status,
          result_ref: operation.resultRef,
        })
        .from(operation)
        .where(
          and(
            inArray(operation.intent, [...intents]),
            inArray(operation.status, ["pending", "unknown"]),
          ),
        )
        .then((rows) =>
          rows.map((row) => ({
            op_key: row.op_key,
            intent: Intent.parse(row.intent),
            status: OperationStatus.parse(row.status),
            result_ref: jsonOrNull(row.result_ref),
          })),
        );
    },

    async listOperations(intents, statuses) {
      const rows = await x
        .select()
        .from(operation)
        .where(
          and(
            inArray(operation.intent, [...intents]),
            inArray(operation.status, [...statuses]),
          ),
        )
        .orderBy(asc(operation.createdAt), asc(operation.opKey));
      return rows.map(toOperation);
    },

    async moveOperation(opKey, to, resultRef, at) {
      const [row] = await x
        .update(operation)
        .set({ status: to, resultRef, updatedAt: at })
        .where(
          and(
            eq(operation.opKey, opKey),
            inArray(operation.status, statusesMovingTo(to)),
          ),
        )
        .returning();
      if (row !== undefined) return toOperation(row);
      const current = await repo.getOperation(opKey);
      throw new Error(
        `operation ${opKey} cannot move from ${current?.status ?? "missing"} to ${to}`,
      );
    },
  };
  return repo;
}

class BundleRefused extends Error {
  constructor(
    readonly index: number,
    readonly active: string | null,
  ) {
    super("bundle refused");
  }
}

export function makeDb(database: Database): Db {
  const base = makeRepo(database);
  const transaction = <T>(work: (tx: Repo) => Promise<T>): Promise<T> =>
    database.transaction((tx) => work(makeRepo(tx)));
  return {
    ...base,
    transaction,
    insertRevision: (row) => transaction((tx) => tx.insertRevision(row)),
    async activateBundle(items, bundleId): Promise<BundleResult> {
      try {
        await transaction(async (tx) => {
          for (const [index, item] of items.entries()) {
            const result = await tx.activate({ ...item, bundle_id: bundleId });
            if (!result.ok) throw new BundleRefused(index, result.active);
          }
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof BundleRefused)
          return { ok: false, index: error.index, active: error.active };
        throw error;
      }
    },
  };
}
