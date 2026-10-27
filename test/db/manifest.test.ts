import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type {
  Dispatch,
  Run,
  Story,
  Task,
} from "../../src/core/domain/ledger.ts";
import { recordManifest } from "../../src/core/manifest/record.ts";
import { storyReference } from "../../src/core/manifest/references.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";

const at = new Date("2026-10-26T00:00:00.000Z");

describeDb("evidence manifest", () => {
  let conn: Connection;

  const story: Story = {
    provider: "tracker",
    external_id: "S-1",
    size: "s",
    stage: "impl",
    run_id: "run-1",
    dependencies: [],
    synced_at: at,
  };
  const run: Run = {
    run_id: "run-1",
    story_provider: "tracker",
    story_external_id: "S-1",
    host: "local",
    coordinator: "session-1",
    owner_generation: 1,
    snapshot_hash: "hash-1",
    state: "active",
    created_at: at,
  };

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    await conn.db.upsertStory(story);
    await conn.db.insertRun(run);
    const spec = await storeRevision(
      conn.db,
      envelope("task", "lineage-1", { goal: "build" }),
    );
    const task: Task = {
      task_id: "task-1",
      run_id: "run-1",
      step_id: "build",
      lineage_id: "lineage-1",
      role: "developer",
      deps: [],
      spec_revision_id: spec.id,
      state: "ready",
      created_at: at,
    };
    await conn.db.insertTask(task);
    await conn.db.insertOperation({
      op_key: "op-d",
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
  });
  afterAll(() => conn.close());

  test("recording the same references returns the stored row", async () => {
    const references = [storyReference(story)];
    const first = await recordManifest(conn.db, {
      run_id: "run-1",
      task_id: "task-1",
      decision_id: null,
      parent_id: null,
      created_at: at,
      references,
    });
    const second = await recordManifest(conn.db, {
      run_id: "run-1",
      task_id: "task-1",
      decision_id: null,
      parent_id: "other-parent",
      created_at: new Date(at.getTime() + 1000),
      references,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.manifest).toEqual(first.manifest);
    expect(await conn.db.getManifest(first.manifest.id)).toEqual(
      first.manifest,
    );
  });

  test("a dispatch round-trips manifest_id and rejects an unknown id", async () => {
    const references = [storyReference({ ...story, stage: "review" })];
    const { manifest } = await recordManifest(conn.db, {
      run_id: "run-1",
      task_id: "task-1",
      decision_id: null,
      parent_id: null,
      created_at: at,
      references,
    });
    const dispatch: Dispatch = {
      dispatch_id: "ctx-manifest",
      task_id: "task-1",
      run_id: "run-1",
      seat: "seat-a",
      role: "developer",
      requested_launch: { model: "m" },
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: "op-d",
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity: "running",
      manifest_id: manifest.id,
    };
    await conn.db.insertDispatch(dispatch);
    expect(await conn.db.getDispatch("ctx-manifest")).toEqual(dispatch);
    const missing: Dispatch = {
      ...dispatch,
      dispatch_id: "ctx-missing",
      manifest_id: "missing",
    };
    await expect(conn.db.insertDispatch(missing)).rejects.toThrow();
    const empty: Dispatch = {
      ...dispatch,
      dispatch_id: "ctx-empty",
      manifest_id: null,
    };
    await conn.db.insertDispatch(empty);
    expect((await conn.db.getDispatch("ctx-empty"))?.manifest_id).toBeNull();
  });
});
