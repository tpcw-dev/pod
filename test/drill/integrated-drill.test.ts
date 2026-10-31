import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeReplayOrca } from "../../src/adapters/orca/replay.ts";
import { makeReplayTracker } from "../../src/adapters/linear/replay.ts";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass, resume } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import { release } from "../../src/core/dispatch/release.ts";
import type { Refusal } from "../../src/core/domain/outcome.ts";
import { postVerdict } from "../../src/core/gate/verdict.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { runCreate } from "../../src/core/run/create.ts";
import { takeover } from "../../src/core/run/takeover.ts";
import { describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import { assertInvariants } from "./assertions.ts";
import {
  candidate,
  compose,
  developerSeat,
  newHandle,
  oldHandle,
  orcaDir,
  reviewerSeat,
  staleHead,
  storyId,
  trackerDir,
  writeIntegrated,
} from "./compose.ts";

test("the composed drill matches the writer byte for byte", () => {
  const built = compose();
  const root = mkdtempSync(join(tmpdir(), "pod-drill-"));
  writeIntegrated(root);
  for (const pair of [
    { dir: orcaDir, files: built.orca },
    { dir: trackerDir, files: built.tracker },
  ]) {
    const { dir, files } = pair;
    expect(readdirSync(dir).sort()).toEqual(files.map((file) => file.name));
    expect(readdirSync(join(root, dir)).sort()).toEqual(
      files.map((file) => file.name),
    );
    for (const file of files) {
      expect(readFileSync(join(dir, file.name), "utf8")).toBe(file.text);
      expect(readFileSync(join(root, dir, file.name), "utf8")).toBe(file.text);
    }
  }
});

function taskId(
  tasks: { task_id: string; step_id: string }[],
  step: string,
): string {
  const found = tasks.find((task) => task.step_id === step);
  if (found === undefined) throw new Error(`no ${step} task`);
  return found.task_id;
}

describeDb("integrated-drill", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
    for (const file of [
      "test/drill/policy.yaml",
      "test/drill/crew.yaml",
      "specs/process/impl-small.yaml",
    ]) {
      const applied = runCli([
        "config",
        "apply",
        file,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, applied.json.error?.message ?? file).toBe(0);
    }
  });
  afterAll(() => conn.close());

  test("one impl-small run walks the five failures and keeps the ledger invariants", async () => {
    const log = receiptLog(conn.db, "rec");
    const verbs: string[] = [];
    const orca = makeReplayOrca({
      dir: orcaDir,
      sink: async (record) => {
        verbs.push(record.verb);
        await log.sink(record);
      },
    });
    const tracker = makeReplayTracker({
      dir: trackerDir,
      sink: log.trackerSink,
      estimateScale: "fibonacci",
    });
    const now = () => new Date();
    const created = await runCreate(conn.db, orca, null, log, {
      story: storyId,
      process: { name: "impl-small", rev: 1 },
      size: "s",
      stage: "impl",
      coordinator: oldHandle,
      host: "rec",
      provider: "linear",
      command: `pod run create story:${storyId}`,
      now,
    });
    if (!created.ok) throw new Error(created.refusal.message);
    const { run_id, tasks } = created.result;
    const implement = taskId(tasks, "implement");
    const review = taskId(tasks, "review");
    const launch = (generation: number) =>
      dispatch(conn.db, orca, log, {
        task: implement,
        seat: developerSeat,
        generation,
        opKey: "drill-1",
        host: "rec",
        capacity: 2,
        command: (opKey) => `pod dispatch --op-key ${opKey}`,
        now,
      });
    const first = await launch(1);
    expect(first).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    const retried = await launch(1);
    expect(retried).toMatchObject({
      ok: false,
      refusal: { code: "launch_unknown" },
    });
    expect(verbs.filter((verb) => verb === "worker-start")).toEqual([
      "worker-start",
    ]);
    expect((await conn.db.getTask(implement))?.state).toBe("hold");
    await assertInvariants(conn);

    const bridge = await checkPass(conn.db, orca, null, log, {
      run: run_id,
      generation: 1,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!bridge.ok) throw new Error(bridge.refusal.message);
    expect(bridge.result.deliveries).toEqual([]);
    expect(bridge.result.reconciled).toEqual([
      { op_key: "drill-1", to: "dispatched" },
    ]);
    expect((await conn.db.getTask(implement))?.state).toBe("dispatched");
    const dispatchId =
      (await conn.db.listDispatches(run_id)).find(
        (row) => row.task_id === implement,
      )?.dispatch_id ?? "";
    expect(dispatchId).not.toBe("");

    const views = mkdtempSync(join(tmpdir(), "pod-drill-view-"));
    const taken = await takeover(conn.db, orca, log, {
      story: storyId,
      provider: "linear",
      generation: 1,
      coordinator: newHandle,
      opKey: null,
      viewPath: (id, generation) => join(views, `${id}-${generation}.html`),
      host: "rec",
      command: (key) => `pod takeover story:${storyId} --op-key ${key}`,
      now,
    });
    if (!taken.ok) throw new Error(taken.refusal.message);
    expect(taken.result.owner_generation).toBe(2);
    const afterTakeover = verbs.length;
    const stale: { ok: false; refusal: Pick<Refusal, "code"> } = {
      ok: false,
      refusal: { code: "owner_generation_stale" },
    };
    expect(
      await checkPass(conn.db, orca, null, log, {
        run: run_id,
        generation: 1,
        host: "rec",
        capacity: 2,
        leaseSeconds: launchLeaseSeconds,
        now,
      }),
    ).toMatchObject(stale);
    expect(
      await release(conn.db, orca, log, {
        dispatch: dispatchId,
        generation: 1,
        retain: null,
        host: "rec",
        now,
      }),
    ).toMatchObject(stale);
    expect(verbs.length).toBe(afterTakeover);

    const delivered = await checkPass(conn.db, orca, null, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!delivered.ok) throw new Error(delivered.refusal.message);
    expect(delivered.result.deliveries).toMatchObject([
      { dispatch_id: dispatchId, outcome: "done" },
    ]);
    expect((await conn.db.getTask(implement))?.state).toBe("done");
    expect((await conn.db.getTask(review))?.state).toBe("ready");

    const started = await dispatch(conn.db, orca, log, {
      task: review,
      seat: reviewerSeat,
      generation: 2,
      opKey: null,
      host: "rec",
      capacity: 2,
      command: (opKey) => `pod dispatch --op-key ${opKey}`,
      now,
    });
    if (!started.ok) throw new Error(started.refusal.message);
    const reviewed = await checkPass(conn.db, orca, null, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!reviewed.ok) throw new Error(reviewed.refusal.message);
    expect(reviewed.result.deliveries).toMatchObject([
      { dispatch_id: started.result.dispatch_id, outcome: "done" },
    ]);
    expect((await conn.db.getTask(review))?.state).toBe("delivered");
    await assertInvariants(conn);

    await conn.db.insertOperation({
      op_key: "drill-status",
      intent: "verdict",
      owner_generation: 2,
      at: now(),
    });
    await conn.db.enqueueOutbox({
      op_key: "drill-status",
      target: "tracker",
      payload: {
        kind: "status",
        story: { provider: "linear", external_id: storyId },
        status: "Doing",
      },
    });
    const held = await checkPass(conn.db, orca, tracker, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!held.ok) throw new Error(held.refusal.message);
    expect((await conn.db.getRun(run_id))?.state).toBe("hold");
    expect((await conn.db.getTask(implement))?.state).toBe("done");
    expect((await conn.db.getTask(review))?.state).toBe("hold");
    await assertInvariants(conn);

    const resumed = await resume(conn.db, {
      run: run_id,
      task: null,
      generation: 2,
      host: "rec",
      now,
    });
    if (!resumed.ok) throw new Error(resumed.refusal.message);
    expect((await conn.db.getRun(run_id))?.state).toBe("active");
    expect((await conn.db.getTask(review))?.state).toBe("delivered");
    expect((await conn.db.getTask(taskId(tasks, "pr")))?.state).toBe(
      "pending",
    );
    const afterResume = await checkPass(conn.db, orca, tracker, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!afterResume.ok) throw new Error(afterResume.refusal.message);
    expect((await conn.db.getRun(run_id))?.state).toBe("active");
    expect(
      await conn.sql`select count(*)::int as n from ledger.event where type = 'cancel'`,
    ).toEqual([{ n: 1 }]);
    await assertInvariants(conn);

    const verdict = (head: string) =>
      postVerdict(conn.db, orca, log, {
        file: {
          gate: "review",
          task: review,
          head_sha: head,
          reviewer: reviewerSeat,
          outcome: "PASS",
        },
        generation: 2,
        host: "rec",
        command: "pod verdict post",
        now,
      });
    expect(await verdict(staleHead)).toMatchObject({
      ok: false,
      refusal: { code: "receipt_stale_sha" },
    });
    expect((await conn.db.getTask(review))?.state).toBe("delivered");
    const passed = await verdict(candidate);
    if (!passed.ok) throw new Error(passed.refusal.message);
    expect((await conn.db.getTask(review))?.state).toBe("done");
    expect((await conn.db.getTask(taskId(tasks, "pr")))?.state).toBe("ready");
    await assertInvariants(conn);

    const posts = () =>
      conn.sql<{ n: number }[]>`
        select count(*)::int as n from ledger.event
        where type = 'receipt' and payload->>'verb' = 'postComment'`;
    const drained = await checkPass(conn.db, orca, tracker, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!drained.ok) throw new Error(drained.refusal.message);
    expect(await posts()).toEqual([{ n: 1 }]);
    const again = await checkPass(conn.db, orca, tracker, log, {
      run: run_id,
      generation: 2,
      host: "rec",
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now,
    });
    if (!again.ok) throw new Error(again.refusal.message);
    expect(await posts()).toEqual([{ n: 1 }]);
    await assertInvariants(conn);
    orca.assertDone();
    tracker.assertDone();
  });
});
