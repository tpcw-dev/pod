import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { recordHqa } from "../../src/core/gate/hqa.ts";
import { contentHash } from "../../src/core/gate/receipt.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import type { TempEntry } from "../orca/temp-fixtures.ts";
import { noCalls, ok } from "../orca/temp-fixtures.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { checkArgs, deliver, gatedRun, type GatedRun } from "./gate-fixture.ts";
import { describeDb, openDb, resetDb } from "./helpers.ts";
import {
  dispatched,
  empty,
  events,
  replay,
  taskState,
  workers,
} from "./run-fixture.ts";

const principals = {
  human: { tracker_account: "keeper-1" },
  relay: { tracker_account: "relay-1" },
};
const hqa = { keeper: "human", type: "HQA" };
const today = () => new Date().toISOString().slice(0, 10);
const quote = () => `keeper-quote: ${today()} "merge it"`;
const run = ["--run", "run_1"];
const quiet: TempEntry[] = [
  ok("check", empty(null), run),
  ok("worker-list", workers([]), run),
];

describeDb("pod check records a delegated HQA verdict", () => {
  let conn: Connection;
  let tracker: FakeTracker;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function setup(over: Partial<GatedRun> = {}) {
    await gatedRun(conn, {
      gates: { merge: hqa },
      gate: "merge",
      principals,
      delegates: ["scribe", "rev-1", "coordinator"],
      ...over,
    });
    tracker = fakeTracker();
  }

  function say(body: string, authorId = "keeper-1") {
    const id = `c-${tracker.comments.length + 1}`;
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: id },
      authorId,
      body,
      editedAt: null,
    });
    return id;
  }

  const delegated = (
    outcome: "PASS" | "FAIL" = "PASS",
    delegate = "scribe",
    lines = [quote()],
  ) =>
    [
      `merge ${outcome}`,
      "checks green",
      ...lines,
      `delegated-by: ${delegate}`,
    ].join("\n");

  async function check(entries: readonly TempEntry[] = quiet) {
    const { orca, log } = replay(conn, entries);
    const checked = await checkPass(conn.db, orca, tracker, log, checkArgs);
    orca.assertDone();
    if (!checked.ok) throw new Error(checked.refusal.message);
    return checked.result.nextSteps;
  }

  async function receipts() {
    return conn.sql<
      {
        id: number;
        task_id: string;
        sync_state: string;
        keeper: string;
        outcome: string;
        source: Record<string, unknown>;
      }[]
    >`select id::int as id, task_id, sync_state, keeper, outcome, source from ledger.gate_receipt order by id`;
  }

  async function receiptEvents() {
    return conn.sql<
      { payload: Record<string, unknown>; source: Record<string, unknown> }[]
    >`select payload, source from ledger.event where type = 'receipt' and payload ? 'gate' order by id`;
  }

  test("a delegated merge PASS is recorded once with the delegate, the quote, and verb check", async () => {
    await setup();
    const body = delegated();
    const id = say(body);
    const steps = await check();
    const [receipt] = await receipts();
    expect(steps).toContain(
      `gate merge receipt ${receipt?.id} recorded from delegate scribe's verdict comment ${id}`,
    );
    expect(await receipts()).toEqual([
      {
        id: expect.any(Number),
        task_id: "task_r",
        sync_state: "synced",
        keeper: "human",
        outcome: "PASS",
        source: {
          kind: "tracker_comment",
          provider: "linear",
          workspace: null,
          issue: "S-1",
          comment_id: id,
          author_id: "keeper-1",
          relayed_by: null,
          content_hash: contentHash(body),
          readback_at: expect.any(String),
          delegate: "scribe",
          keeper_quote: quote(),
        },
      },
    ]);
    expect(await receiptEvents()).toEqual([
      {
        payload: {
          receipt_id: receipt?.id,
          gate: "merge",
          outcome: "PASS",
          comment_id: id,
          actor: "delegate:scribe",
          keeper: "human",
        },
        source: { kind: "command", verb: "check" },
      },
    ]);
    expect(await taskState(conn, "task_r")).toBe("done");
    expect(await taskState(conn, "task_s")).toBe("ready");

    await check();
    expect(await receipts()).toHaveLength(1);
  });

  const refusedLine = (id: string, reason: string, author = "keeper-1") =>
    `receipt_unverified_source: gate merge comment ${id} by ${author} is not a verified delegated verdict (${reason}); the Gate stays waiting`;

  test.each([
    [
      "an unlisted name",
      () => delegated("PASS", "other"),
      "delegate_not_listed",
    ],
    [
      "an upper-case name",
      () => delegated("PASS", "Scribe"),
      "delegate_not_listed",
    ],
    [
      "a missing quote line",
      () => delegated("PASS", "scribe", []),
      "delegate_without_quote",
    ],
    [
      "a quote dated two days ahead",
      () =>
        delegated("PASS", "scribe", [
          `keeper-quote: ${new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)} "merge it"`,
        ]),
      "quote_date_invalid",
    ],
  ])("%s writes no receipt and prints its reason", async (_, body, reason) => {
    await setup();
    const id = say(body());
    expect(await check()).toContain(refusedLine(id, reason));
    expect(await receipts()).toEqual([]);
    expect(await taskState(conn, "task_r")).toBe("delivered");
  });

  test("a comment by another account writes no receipt", async () => {
    await setup();
    const id = say(delegated(), "relay-1");
    expect(await check()).toContain(
      refusedLine(id, "delegate_author_not_keeper", "relay-1"),
    );
    expect(await receipts()).toEqual([]);
  });

  test("an edited comment writes no receipt", async () => {
    await setup();
    const id = say(delegated());
    const [first] = tracker.comments;
    if (first !== undefined) first.editedAt = new Date().toISOString();
    expect(await check()).toContain(refusedLine(id, "edited"));
    expect(await receipts()).toEqual([]);
  });

  test("a second read that differs writes no receipt", async () => {
    await setup();
    const id = say(delegated());
    const read = tracker.readComment.bind(tracker);
    tracker.readComment = async (ref) => {
      const found = await read(ref);
      return found.result === null
        ? found
        : { ...found, result: { ...found.result, body: "merge FAIL" } };
    };
    expect(await check()).toContain(refusedLine(id, "readback_differs"));
    expect(await receipts()).toEqual([]);
  });

  test.each([["rev-1"], ["coordinator"]])(
    "a delegate named %s, a Seat of the Run, writes no receipt",
    async (name) => {
      await setup();
      const id = say(delegated("PASS", name));
      expect(await check()).toContain(
        `activation_needs_person: gate merge comment ${id}: delegate ${name} is a Seat of Run run_1; the Gate stays waiting`,
      );
      expect(await receipts()).toEqual([]);
      expect(tracker.calls).not.toContain("readComment");
    },
  );

  test("the keeper's own comment and a relayed one print nothing here", async () => {
    await setup();
    say("merge PASS");
    say(`merge PASS\nrelayed-by: s1`, "relay-1");
    const steps = await check();
    expect(steps.filter((line) => line.includes("comment c-"))).toEqual([]);
    expect(await receipts()).toEqual([]);
  });

  test("hqa_after_deploy with no deploy event writes no receipt", async () => {
    await setup({
      gates: { hqa_after_deploy: hqa },
      gate: "hqa_after_deploy",
    });
    say(["hqa_after_deploy PASS", quote(), "delegated-by: scribe"].join("\n"));
    const steps = await check();
    expect(steps).toContain(
      "receipt_no_deploy: gate hqa_after_deploy needs a deploy event on Run run_1",
    );
    expect(await receipts()).toEqual([]);
  });

  test("an edit after the receipt voids it, and the comment is not recorded again", async () => {
    await setup();
    const id = say(delegated());
    await check();
    const [receipt] = await receipts();
    const [first] = tracker.comments;
    if (first !== undefined) {
      first.body = `${first.body}\nedited`;
      first.editedAt = new Date().toISOString();
    }
    expect(await check()).toContain(
      `receipt ${receipt?.id} on gate merge is voided because its comment changed; the Run is on hold until pod check --resume`,
    );
    expect((await receipts()).map((row) => row.sync_state)).toEqual(["voided"]);
    expect(id).toBe("c-1");
  });

  function bypassFile() {
    const path = join(mkdtempSync(join(tmpdir(), "pod-hqa-")), "bypass.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
    );
    return path;
  }

  function record() {
    return recordHqa(
      conn.db,
      noCalls(),
      tracker,
      receiptLog(conn.db, "local"),
      {
        story: { provider: "linear", external_id: "S-1" },
        generation: 1,
        host: "local",
        hostName: "h1",
        bypassPath: bypassFile(),
        principal: "human",
        command: "pod hqa record story:S-1 --generation 1",
        now: () => new Date(),
      },
    );
  }

  test.each([["scribe"], ["Scribe"]])(
    "pod hqa record refuses a comment delegated by %s with delegated_verdict",
    async (name) => {
      await setup();
      const id = say(delegated("PASS", name));
      expect(await record()).toEqual({
        ok: false,
        refusal: {
          code: "receipt_unverified_source",
          message: `gate merge: comment ${id} by keeper-1 is a delegated verdict (delegated_verdict); the Gate stays waiting`,
          nextSteps: ["the Run's pod check records a delegated verdict"],
        },
      });
      expect(tracker.calls).toEqual(["readback"]);
      expect(await receipts()).toEqual([]);
    },
  );

  test("two Tasks waiting on an HQA gate record nothing", async () => {
    await setup({ shipGate: "merge" });
    await conn.sql`update ledger.task set state = 'delivered' where task_id = 'task_s'`;
    say(delegated());
    expect(await check()).toContain(
      "more than one delivered Task waits on an HQA gate: task_r (merge), task_s (merge); a delegated verdict records one gate at a time, settle the other Task first",
    );
    expect(await receipts()).toEqual([]);
  });

  test("a delegated FAIL on a hold edge holds the Task, calls no Orca write, and is recorded once", async () => {
    await setup();
    say(delegated("FAIL"));
    await check();
    expect(await taskState(conn, "task_r")).toBe("hold");
    expect(
      (await events(conn, "hold"))
        .filter((row) => row.task_id === "task_r")
        .map((row) => row.payload),
    ).toEqual([{ reason: "edge", outcome: "FAIL", from: "delivered" }]);
    const tasks = (await conn.db.listTasks("run_1")).length;
    const steps = await check();
    expect(steps.filter((line) => line.includes("task_r"))).toEqual([]);
    expect((await conn.db.listTasks("run_1")).length).toBe(tasks);
    expect(await receipts()).toHaveLength(1);
  });
});

describeDb("a delegated FAIL on a rework edge", () => {
  let conn: Connection;
  let tracker: FakeTracker;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  async function setup(reviewFail: "rework" | "rework_self" = "rework") {
    await gatedRun(conn, {
      gates: { merge: hqa },
      gate: "merge",
      principals,
      delegates: ["scribe"],
      review: "human_wait",
      reviewFail,
    });
    tracker = fakeTracker();
  }

  function say(outcome: "PASS" | "FAIL", authorId = "keeper-1") {
    const id = `c-${tracker.comments.length + 1}`;
    tracker.comments.unshift({
      ref: { provider: "linear", external_id: "S-1", comment_id: id },
      authorId,
      body: [`merge ${outcome}`, quote(), "delegated-by: scribe"].join("\n"),
      editedAt: null,
    });
    return id;
  }

  async function check(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    const checked = await checkPass(conn.db, orca, tracker, log, checkArgs);
    orca.assertDone();
    if (!checked.ok) throw new Error(checked.refusal.message);
    return checked.result.nextSteps;
  }

  async function stopped(entries: readonly TempEntry[]) {
    const { orca, log } = replay(conn, entries);
    await expect(
      checkPass(conn.db, orca, tracker, log, checkArgs),
    ).rejects.toThrow();
  }

  const update = ok("task-update", {}, [
    "--id",
    "task_r",
    "--status",
    "failed",
  ]);
  const created = (id: string, status: string) =>
    ok("task-create", { task: { id, status } });
  const build = created("task_b2", "ready");
  const ship = created("task_s2", "pending");
  const checkOnly = ok("check", empty(null), run);
  const list = ok("worker-list", workers([]), run);

  async function tasks() {
    return (await conn.db.listTasks("run_1")).map((row) => ({
      task_id: row.task_id,
      step_id: row.step_id,
      state: row.state,
      rework_of: row.rework_of,
      deps: row.deps,
    }));
  }

  async function liveDependsOnReview() {
    return (await conn.db.listTasks("run_1")).filter(
      (row) =>
        !["done", "failed", "superseded"].includes(row.state) &&
        (row.deps as string[]).includes("task_r"),
    );
  }

  async function dropPendingProjectOps() {
    await conn.sql`delete from ledger.operation where intent = 'project' and status = 'pending'`;
  }

  test("one pass creates the build and ship Tasks, and the next pass creates none", async () => {
    await setup();
    say("FAIL");
    await check([update, build, ship, checkOnly, list]);
    expect(await taskState(conn, "task_r")).toBe("failed");
    expect(await tasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: "task_b2",
          step_id: "build",
          rework_of: "task_b",
        }),
        expect.objectContaining({
          task_id: "task_s2",
          step_id: "ship",
          rework_of: "task_s",
          deps: ["task_b2"],
        }),
      ]),
    );
    expect((await tasks()).filter((row) => row.rework_of === "task_r")).toEqual(
      [],
    );
    expect(await liveDependsOnReview()).toEqual([]);
    await check([checkOnly, list]);
    expect(await tasks()).toHaveLength(5);
  });

  test("two unrecorded delegated verdicts record nothing", async () => {
    await setup();
    const fail = say("FAIL");
    const pass = say("PASS");
    expect(await check([checkOnly, list])).toContain(
      `gate merge has more than one unrecorded delegated verdict comment: ${pass}, ${fail}; delete the ones that are not the verdict and run pod check again`,
    );
    expect(await taskState(conn, "task_r")).toBe("ready");
  });

  test("a pass stopped before the first taskCreate is finished by the next pass", async () => {
    await setup();
    say("FAIL");
    await stopped([update]);
    await dropPendingProjectOps();
    expect(await taskState(conn, "task_r")).toBe("failed");
    expect(await tasks()).toHaveLength(3);
    await check([checkOnly, build, ship, list]);
    expect(await tasks()).toHaveLength(5);
    expect(await liveDependsOnReview()).toEqual([]);
    await check([checkOnly, list]);
    expect(await tasks()).toHaveLength(5);
  });

  test("a pass stopped between the two taskCreates reuses the build Task", async () => {
    await setup();
    say("FAIL");
    await stopped([update, build]);
    await dropPendingProjectOps();
    expect(await tasks()).toHaveLength(4);
    await check([checkOnly, ship, list]);
    expect(await tasks()).toHaveLength(5);
    expect(await liveDependsOnReview()).toEqual([]);
  });

  test("a pass stopped before the reroute is rerouted by the next pass", async () => {
    await setup();
    say("FAIL");
    await check([update, build, ship, checkOnly, list]);
    await conn.sql`update ledger.task set deps = '["task_r"]'::jsonb where task_id = 'task_s'`;
    expect(await liveDependsOnReview()).toHaveLength(1);
    await check([checkOnly, list]);
    expect(await liveDependsOnReview()).toEqual([]);
    expect(await tasks()).toHaveLength(5);
    await check([checkOnly, list]);
    expect(await tasks()).toHaveLength(5);
  });

  test("a failed build taskCreate is not retried", async () => {
    await setup();
    say("FAIL");
    await check([
      update,
      {
        verb: "task-create",
        argv: [],
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "bad_request", message: "no" },
        }),
      },
      checkOnly,
      list,
    ]);
    expect(await tasks()).toHaveLength(3);
    expect((await conn.db.getRun("run_1"))?.state).toBe("hold");
    expect(await check([checkOnly, list])).toContain(
      "task-create for step build failed before",
    );
    expect(await tasks()).toHaveLength(3);
  });

  test("a failed taskUpdate is sent again by a later pass", async () => {
    await setup();
    say("FAIL");
    const failedUpdate: TempEntry = {
      verb: "task-update",
      argv: ["--id", "task_r", "--status", "failed"],
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "task_not_found", message: "no task" },
      }),
    };
    await check([failedUpdate, build, ship, checkOnly, failedUpdate, list]);
    await check([checkOnly, update, list]);
    await check([checkOnly, list]);
    expect(await tasks()).toHaveLength(5);
  });

  test("a keeper's FAIL whose rework stopped is finished by pod check, and a voided one is not", async () => {
    for (const voided of [false, true]) {
      await setup();
      const id = `c-${tracker.comments.length + 1}`;
      tracker.comments.unshift({
        ref: { provider: "linear", external_id: "S-1", comment_id: id },
        authorId: "keeper-1",
        body: "merge FAIL",
        editedAt: null,
      });
      const { orca, log } = replay(conn, [update]);
      await expect(
        recordHqa(conn.db, orca, tracker, log, {
          story: { provider: "linear", external_id: "S-1" },
          generation: 1,
          host: "local",
          hostName: "h1",
          bypassPath: (() => {
            const path = join(
              mkdtempSync(join(tmpdir(), "pod-hqa-")),
              "bypass.jsonl",
            );
            writeFileSync(
              path,
              `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
            );
            return path;
          })(),
          principal: "human",
          command: "pod hqa record story:S-1 --generation 1",
          now: () => new Date(),
        }),
      ).rejects.toThrow();
      await dropPendingProjectOps();
      if (voided)
        await conn.sql`update ledger.gate_receipt set sync_state = 'voided'`;
      await check(voided ? [checkOnly, list] : [checkOnly, build, ship, list]);
      expect(await tasks()).toHaveLength(voided ? 3 : 5);
    }
  });

  test.each([["newest first"], ["oldest first"]])(
    "with then on the failed step, a later PASS is recorded on the new review Task (%s)",
    async (order) => {
      await setup("rework_self");
      const fail = say("FAIL");
      await check([
        update,
        build,
        created("task_r2", "pending"),
        checkOnly,
        list,
      ]);
      expect(await tasks()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            task_id: "task_r2",
            step_id: "review",
            rework_of: "task_r",
          }),
        ]),
      );
      await dispatched(conn, "ctx_3", { task: "task_b2", seat: "dev-1" });
      await deliver(conn, "ctx_3", "task_b2");
      expect(await taskState(conn, "task_r2")).toBe("ready");
      const pass = say("PASS");
      if (order === "oldest first") tracker.comments.reverse();
      const steps = await check([
        ok("task-update", {}, ["--id", "task_r2", "--status", "completed"]),
        checkOnly,
        list,
      ]);
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `from delegate scribe's verdict comment ${pass}`,
          ),
        ]),
      );
      expect(await taskState(conn, "task_r2")).toBe("done");
      const receipts = await conn.sql<
        { task_id: string; comment_id: string }[]
      >`select task_id, source->>'comment_id' as comment_id from ledger.gate_receipt order by id`;
      expect(receipts).toEqual([
        { task_id: "task_r", comment_id: fail },
        { task_id: "task_r2", comment_id: pass },
      ]);
    },
  );
});
