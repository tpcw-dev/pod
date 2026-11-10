import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { singleActive } from "../../src/core/config/active.ts";
import { deriveOpKey } from "../../src/core/config/apply.ts";
import { ok } from "../orca/temp-fixtures.ts";
import { fakeTracker, type FakeTracker } from "./fake-tracker.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { operator } from "./identity-fixture.ts";
import { createRun, empty, replay, workers } from "./run-fixture.ts";
import { crewValue, seedConfig } from "./seed.ts";

const dir = mkdtempSync(join(tmpdir(), "pod-activate-"));
const bypassPath = join(dir, "bypass.jsonl");
writeFileSync(
  bypassPath,
  `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
);

const gates = {
  pr: { keeper: "reviewer-seat", type: "AQA" },
  hqa_after_deploy: { keeper: operator, type: "HQA" },
};
const principals = { [operator]: { tracker_account: "keeper-1" } };
const seat = { POD_SEAT: "developer" };

interface Pending {
  id: string;
  ref: string;
  activation: unknown;
  pending: {
    op_key: string;
    comment: string;
    ticket: string | null;
    profile: string | null;
  } | null;
}

describeDb("config activate requests", () => {
  let conn: Connection;
  let tracker: FakeTracker;
  let failing: Set<string>;
  let comments: Map<
    string,
    { id: string; body: string; author: string; edited: boolean }[]
  >;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    const { policy } = await seedConfig(conn.db);
    const keeper = await storeRevision(
      conn.db,
      envelope("policy", "default", { gates, principals }),
    );
    const moved = await conn.db.activate({
      scope: "global",
      scope_ref: "",
      kind: "policy",
      name: "default",
      expected: policy.id,
      revision_id: keeper.id,
      bundle_id: null,
      activated_by: "operator",
      activated_at: new Date(),
    });
    if (!moved.ok) throw new Error("keeper policy did not activate");
    await createRun(conn);
    comments = new Map();
    failing = new Set();
    tracker = fakeTracker();
    const toComment = (ticket: string) =>
      (comments.get(ticket) ?? []).map((row) => ({
        ref: { provider: "linear", external_id: ticket, comment_id: row.id },
        authorId: row.author,
        body: row.body,
        editedAt: row.edited ? "2026-11-10T00:00:00.000Z" : null,
      }));
    tracker.readback = (ref) => {
      tracker.calls.push(`readback:${ref.external_id}`);
      if (failing.has(ref.external_id))
        return Promise.resolve({
          verb: "readback",
          ok: false,
          result: null,
          raw: null,
          error: "timeout",
          requestId: null,
        });
      return Promise.resolve({
        verb: "readback",
        ok: true,
        result: {
          kind: "story",
          story: tracker.story,
          comments: toComment(ref.external_id),
        },
        raw: null,
        error: null,
        requestId: null,
      });
    };
    tracker.readComment = (ref) => {
      const found = toComment(ref.external_id).find(
        (row) => row.ref.comment_id === ref.comment_id,
      );
      return Promise.resolve({
        verb: "readComment",
        ok: found !== undefined,
        result: found ?? null,
        raw: null,
        error: found === undefined ? "not_found" : null,
        requestId: null,
      });
    };
  });

  function say(
    ticket: string,
    id: string,
    body: string,
    author = "keeper-1",
    edited = false,
  ) {
    comments.set(ticket, [
      { id, body, author, edited },
      ...(comments.get(ticket) ?? []),
    ]);
  }

  async function check(): Promise<string[]> {
    const { orca, log } = replay(conn, [
      ok("check", empty(null), ["--run", "run_1"]),
      ok("worker-list", workers([]), ["--run", "run_1"]),
    ]);
    const outcome = await checkPass(conn.db, orca, tracker, log, {
      run: "run_1",
      generation: 1,
      host: "local",
      hostName: "h1",
      bypassPath,
      capacity: 2,
      leaseSeconds: launchLeaseSeconds,
      now: () => new Date(),
    });
    orca.assertDone();
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    return outcome.result.nextSteps.filter(
      (step) => !step.startsWith("usage has no source"),
    );
  }

  function agentSet(model: string, ticket = "TRK-9"): Pending {
    const result = runCli(
      [
        "config",
        "set",
        "crew.default",
        `seats[0].model=${model}`,
        "--reason",
        "agent edit",
        "--ticket",
        ticket,
      ],
      seat,
    );
    expect(result.status, result.json.error?.message).toBe(0);
    return result.json.result as unknown as Pending;
  }

  function exported(ref: string): string {
    const out = join(dir, `${ref}.yaml`);
    const result = runCli(["config", "export", ref, "--out", out]);
    expect(result.status, result.json.error?.message).toBe(0);
    return out;
  }

  function agentApply(path: string, ticket: string): Pending {
    const result = runCli(["config", "apply", path, "--ticket", ticket], seat);
    expect(result.status, result.json.error?.message).toBe(0);
    return result.json.result as unknown as Pending;
  }

  const activeCrew = async () =>
    (await singleActive(conn.db, "crew", "global", ""))?.id;

  async function status(opKey: string) {
    return (await conn.db.getOperation(opKey))?.status;
  }

  async function count(table: string, where: string): Promise<number> {
    const rows = await conn.sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${table} where ${where}`,
    );
    return rows[0]?.n ?? 0;
  }

  test("an agent set waits as a pending request and prints the comment", async () => {
    const before = await activeCrew();
    const written = agentSet("m-2");
    expect(written.activation).toBeNull();
    expect(written.pending).toMatchObject({
      comment: `config activate ${written.id}`,
      ticket: "TRK-9",
      profile: null,
    });
    expect(await activeCrew()).toBe(before);
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
    expect(await count("ledger.operation", "intent = 'config_activate'")).toBe(
      1,
    );
    const [event] = await conn.sql<
      { payload: Record<string, unknown>; source: unknown }[]
    >`select payload, source from ledger.event where type = 'activation_requested'`;
    expect(event?.payload).toMatchObject({
      kind: "crew",
      name: "default",
      revision_id: written.id,
      expected: before,
      ticket: "TRK-9",
      actor: "seat:developer",
    });
    expect(event?.source).toEqual({ kind: "command", verb: "config set" });
    expect(agentSet("m-2")).toEqual(written);
    expect(await count("ledger.operation", "intent = 'config_activate'")).toBe(
      1,
    );
  });

  test("an agent write without --ticket is usage naming --ticket and writes nothing", async () => {
    const before = await count("config.revision", "true");
    const refused = runCli(
      ["config", "set", "crew.default", "seats[0].model=m-2", "--reason", "r"],
      seat,
    );
    expect(refused.status).toBe(2);
    expect(refused.json.error?.code).toBe("usage");
    expect(refused.json.error?.nextSteps.join(" ")).toContain("--ticket");
    expect(await count("config.revision", "true")).toBe(before);
  });

  test("a keeper comment on the ticket activates once as the person", async () => {
    const written = agentSet("m-2");
    say("TRK-9", "c-1", `config activate ${written.id}\nlooks right`);
    expect(await check()).toEqual([]);
    expect(await activeCrew()).toBe(written.id);
    expect(await status(written.pending?.op_key ?? "")).toBe("done");
    const [row] = await conn.sql<{ activated_by: string }[]>`
      select activated_by from config.activation
      where kind = 'crew' and name = 'default'`;
    expect(row?.activated_by).toBe(`person:${operator}`);
    const [event] = await conn.sql<{ source: Record<string, unknown> }[]>`
      select source from ledger.event where type = 'activation'
      order by id desc limit 1`;
    expect(event?.source).toMatchObject({
      kind: "tracker_comment",
      comment_id: "c-1",
      author: "keeper-1",
    });
    const activations = await count("ledger.event", "type = 'activation'");
    await check();
    expect(await count("ledger.event", "type = 'activation'")).toBe(
      activations,
    );
    expect(tracker.calls).toContain("readback:TRK-9");
  });

  test("a non-keeper comment is refused and the request stays pending", async () => {
    const written = agentSet("m-2");
    const before = await activeCrew();
    say("TRK-9", "c-1", `config activate ${written.id}`, "bot");
    expect(await check()).toContainEqual(
      expect.stringMatching(
        /^receipt_unverified_source: config activate request ".*" comment c-1 by bot is not a verified human source \(not_a_human_source\)/,
      ),
    );
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
    expect(await activeCrew()).toBe(before);
  });

  test("an edited keeper comment is refused and the request stays pending", async () => {
    const written = agentSet("m-2");
    say("TRK-9", "c-1", `config activate ${written.id}`, "keeper-1", true);
    expect(await check()).toContainEqual(
      expect.stringMatching(/comment c-1 by keeper-1 .*\(edited\)/),
    );
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
  });

  test("a keeper comment after another activation is refused revision_conflict", async () => {
    const written = agentSet("m-2");
    const moved = runCli([
      "config",
      "set",
      "crew.default",
      "seats[0].model=m-3",
      "--reason",
      "operator edit",
      "--activate",
    ]);
    expect(moved.status, moved.json.error?.message).toBe(0);
    const active = await activeCrew();
    say("TRK-9", "c-1", `config activate ${written.id}`);
    expect(await check()).toContainEqual(
      expect.stringMatching(/^revision_conflict: config activate request/),
    );
    expect(await status(written.pending?.op_key ?? "")).toBe("refused");
    expect(await activeCrew()).toBe(active);
    const [row] = await conn.sql<{ result_ref: Record<string, unknown> }[]>`
      select result_ref from ledger.operation
      where op_key = ${written.pending?.op_key ?? ""}`;
    expect(row?.result_ref).toMatchObject({
      code: "revision_conflict",
      active,
      comment_id: "c-1",
    });
  });

  test("one comment activates through the request whose expected is active and settles both", async () => {
    const stale = agentSet("m-2");
    const other = runCli([
      "config",
      "set",
      "crew.default",
      "seats[0].model=m-3",
      "--reason",
      "operator edit",
      "--activate",
    ]);
    expect(other.status).toBe(0);
    const fresh = agentApply(exported(stale.ref), "TRK-9");
    expect(fresh.id).toBe(stale.id);
    expect(fresh.pending?.op_key).not.toBe(stale.pending?.op_key);
    say("TRK-9", "c-1", `config activate ${stale.id}`);
    expect(await check()).toEqual([]);
    expect(await activeCrew()).toBe(stale.id);
    expect(await status(stale.pending?.op_key ?? "")).toBe("done");
    expect(await status(fresh.pending?.op_key ?? "")).toBe("done");
  });

  test("two tickets for one Revision open two requests, and a comment on either settles both", async () => {
    const first = agentSet("m-2", "TRK-9");
    const second = agentSet("m-2", "TRK-10");
    expect(second.id).toBe(first.id);
    expect(second.pending?.op_key).not.toBe(first.pending?.op_key);
    say("TRK-10", "c-1", `config activate ${first.id}`);
    expect(await check()).toEqual([]);
    expect(await activeCrew()).toBe(first.id);
    expect(await status(first.pending?.op_key ?? "")).toBe("done");
    expect(await status(second.pending?.op_key ?? "")).toBe("done");
  });

  test("a TPC-1413 pending config_apply row activates on the Run's Story", async () => {
    const before = await activeCrew();
    const revision = await storeRevision(
      conn.db,
      envelope("crew", "default", { ...crewValue, note: "legacy" }),
    );
    const opKey = "config_apply:legacy";
    const comment = "profile legacy p crew.default@2";
    await conn.db.insertOperation({
      op_key: opKey,
      intent: "config_apply",
      owner_generation: 0,
      at: new Date(),
      result_ref: {
        pending: {
          scope: "global",
          scope_ref: "",
          kind: "crew",
          name: "default",
          revision_id: revision.id,
          expected: before ?? null,
          profile: "p",
          comment,
        },
        result: {
          ref: "crew.default@2",
          id: revision.id,
          rev: revision.rev,
          created: true,
          activation: null,
          pending: {
            op_key: opKey,
            profile: "p",
            comment,
            runs_on_old_profile: [],
            readback: "legacy",
          },
        },
      },
    });
    say("S-1", "c-1", comment);
    expect(await check()).toEqual([]);
    expect(await activeCrew()).toBe(revision.id);
    expect(await status(opKey)).toBe("done");
  });

  test("a comment that settled a TPC-1413 row does not activate a later request", async () => {
    const written = agentSet("m-2");
    await conn.db.appendEvent({
      type: "activation",
      ts: new Date(),
      host: "local",
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: { kind: "crew", name: "default", revision_id: written.id },
      source: {
        kind: "tracker_comment",
        comment_id: "c-old",
        author: "keeper-1",
        readback_at: "2026-11-01T00:00:00.000Z",
      },
    });
    const before = await activeCrew();
    say("TRK-9", "c-old", `config activate ${written.id}`);
    expect(await check()).toEqual([]);
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
    expect(await activeCrew()).toBe(before);
  });

  test("pod config activate from the operator activates and closes the request", async () => {
    const written = agentSet("m-2");
    const before = await activeCrew();
    const done = runCli([
      "config",
      "activate",
      written.ref,
      "--scope",
      "global",
      "--expected-revision",
      before ?? "none",
    ]);
    expect(done.status, done.json.error?.message).toBe(0);
    expect(done.json.result).toMatchObject({
      id: written.id,
      activation: { revision_id: written.id, previous_revision_id: before },
    });
    expect(await activeCrew()).toBe(written.id);
    expect(await status(written.pending?.op_key ?? "")).toBe("done");
    const [row] = await conn.sql<{ result_ref: Record<string, unknown> }[]>`
      select result_ref from ledger.operation
      where op_key = ${written.pending?.op_key ?? ""}`;
    expect(row?.result_ref["source"]).toEqual({
      kind: "command",
      verb: "config activate",
    });
    const [event] = await conn.sql<{ source: unknown }[]>`
      select source from ledger.event where type = 'activation'
      order by id desc limit 1`;
    expect(event?.source).toEqual({ kind: "command", verb: "config activate" });
  });

  test("pod config activate with a stale expected Revision is revision_conflict", async () => {
    const written = agentSet("m-2");
    const refused = runCli([
      "config",
      "activate",
      written.ref,
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("revision_conflict");
    expect(refused.json.error?.nextSteps.join(" ")).toContain(
      `pod config activate ${written.ref} --scope global --expected-revision`,
    );
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
  });

  test("pod config activate from a Seat is activation_needs_person and writes nothing", async () => {
    const written = agentSet("m-2");
    const before = await activeCrew();
    const activations = await count("ledger.event", "type = 'activation'");
    const refused = runCli(
      [
        "config",
        "activate",
        written.ref,
        "--scope",
        "global",
        "--expected-revision",
        before ?? "none",
      ],
      seat,
    );
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");
    expect(await activeCrew()).toBe(before);
    expect(await status(written.pending?.op_key ?? "")).toBe("pending");
    expect(await count("ledger.event", "type = 'activation'")).toBe(
      activations,
    );
  });

  test("pod config activate with a scope other than the Revision's is usage", () => {
    const written = agentSet("m-2");
    const refused = runCli([
      "config",
      "activate",
      written.ref,
      "--scope",
      "project:p1",
      "--expected-revision",
      "none",
    ]);
    expect(refused.status, JSON.stringify(refused.json.error)).toBe(2);
    expect(refused.json.error?.code).toBe("usage");
  });

  test("an agent write of the active Revision opens no request", async () => {
    const result = agentApply(exported("crew.default@1"), "TRK-9");
    expect(result).toMatchObject({ pending: null });
    expect(await count("ledger.operation", "intent = 'config_activate'")).toBe(
      0,
    );
  });

  test("an agent task write is not a request and needs no ticket", async () => {
    const path = join(dir, "task.yaml");
    writeFileSync(
      path,
      "kind: task\nname: lineage-1\nschema_version: 1\nscope: run\nscope_ref: run_1\nvalue: { spec: x }\n",
    );
    const result = runCli(["config", "apply", path], seat);
    expect(result.status, result.json.error?.message).toBe(0);
    expect(result.json.result).toMatchObject({
      activation: null,
      pending: null,
    });
    expect(await count("ledger.operation", "intent = 'config_activate'")).toBe(
      0,
    );
  });

  test("pod brief lists the pending request with its comment and pod state counts it", () => {
    const written = agentSet("m-2");
    const brief = runCli(["brief"]);
    expect(brief.status, brief.json.error?.message).toBe(0);
    expect(
      (brief.json.result as { pending_requests: unknown[] }).pending_requests,
    ).toEqual([
      {
        op_key: written.pending?.op_key,
        ref: written.ref,
        scope: "global",
        ticket: "TRK-9",
        actor: "seat:developer",
        comment: `config activate ${written.id}`,
      },
    ]);
    const state = runCli(["state", "--json"]);
    expect(state.status, state.json.error?.message).toBe(0);
    expect(
      (state.json.result as { policies: { pending_requests: number } }).policies
        .pending_requests,
    ).toBe(1);
  });

  function operatorActivate(ref: string, expected: string | undefined) {
    return runCli([
      "config",
      "activate",
      ref,
      "--scope",
      "global",
      "--expected-revision",
      expected ?? "none",
    ]);
  }

  test("pod config activate activates again after the active Revision moved away and back", async () => {
    const seed = await activeCrew();
    const written = agentSet("m-2");
    expect(operatorActivate(written.ref, seed).status).toBe(0);
    expect(operatorActivate(written.ref, seed).json.result).toMatchObject({
      activation: { revision_id: written.id },
    });
    expect(operatorActivate("crew.default@1", written.id).status).toBe(0);
    expect(await activeCrew()).toBe(seed);
    const again = operatorActivate(written.ref, seed);
    expect(again.status, again.json.error?.message).toBe(0);
    expect(await activeCrew()).toBe(written.id);
  });

  test("pod config activate moves a TPC-1413 pending row at its own op key to done", async () => {
    const seed = await activeCrew();
    const revision = await storeRevision(
      conn.db,
      envelope("crew", "default", { ...crewValue, note: "legacy" }),
    );
    const opKey = deriveOpKey(
      envelope("crew", "default", { ...crewValue, note: "legacy" }),
      seed ?? null,
      revision.id,
    );
    await conn.db.insertOperation({
      op_key: opKey,
      intent: "config_apply",
      owner_generation: 0,
      at: new Date(),
      result_ref: {
        pending: {
          scope: "global",
          scope_ref: "",
          kind: "crew",
          name: "default",
          revision_id: revision.id,
          expected: seed ?? null,
          profile: "p",
          comment: "profile legacy p crew.default@2",
        },
        result: {
          ref: "crew.default@2",
          id: revision.id,
          rev: revision.rev,
          created: true,
          activation: null,
          pending: null,
        },
      },
    });
    const done = operatorActivate("crew.default@2", seed);
    expect(done.status, done.json.error?.message).toBe(0);
    expect(await activeCrew()).toBe(revision.id);
    expect(await status(opKey)).toBe("done");
  });

  test("a Seat write repeated after its request settled opens a new request", async () => {
    const seed = await activeCrew();
    const first = agentSet("m-2");
    expect(operatorActivate(first.ref, seed).status).toBe(0);
    expect(operatorActivate("crew.default@1", first.id).status).toBe(0);
    const again = agentApply(exported(first.ref), "TRK-9");
    expect(again.pending?.op_key).toBeDefined();
    expect(again.pending?.op_key).not.toBe(first.pending?.op_key);
    expect(await status(again.pending?.op_key ?? "")).toBe("pending");
  });

  test("a failed Story read leaves a ticket's approval free to activate", async () => {
    const seed = await activeCrew();
    const legacy = await storeRevision(
      conn.db,
      envelope("crew", "default", { ...crewValue, note: "legacy" }),
    );
    await conn.db.insertOperation({
      op_key: "config_apply:legacy",
      intent: "config_apply",
      owner_generation: 0,
      at: new Date(),
      result_ref: {
        pending: {
          scope: "global",
          scope_ref: "",
          kind: "crew",
          name: "default",
          revision_id: legacy.id,
          expected: seed ?? null,
          profile: "p",
          comment: "profile legacy p crew.default@2",
        },
        result: {
          ref: "crew.default@2",
          id: legacy.id,
          rev: legacy.rev,
          created: true,
          activation: null,
          pending: null,
        },
      },
    });
    const written = agentSet("m-2");
    failing.add("S-1");
    say("TRK-9", "c-1", `config activate ${written.id}`);
    expect(await check()).toContainEqual(
      expect.stringMatching(/^tracker readback of story:S-1 failed: timeout/),
    );
    expect(await activeCrew()).toBe(written.id);
    expect(await status("config_apply:legacy")).toBe("pending");
  });
});
