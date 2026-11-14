import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { parseRate, validateRate } from "../../src/core/config/rate.ts";
import type { Json } from "../../src/core/domain/json.ts";
import type { NewUsageRecord } from "../../src/core/domain/usage.ts";
import { listPrice, usageCost } from "../../src/core/usage/cost.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { createRun } from "./run-fixture.ts";
import { activeRevision, seedConfig } from "./seed.ts";

const at = new Date("2026-11-10T08:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "pod-rate-"));
const seat = { POD_SEAT: "developer" };

function rateValue(input: number): Json {
  return {
    currency: "XXX",
    prices: [
      {
        runtime: "example-runtime",
        model: "example-model",
        input,
        cached_input: 0.5,
        cache_write: 4,
        output: 20,
        per: 1000000,
      },
    ],
  };
}

function pinned(id: string, input: number) {
  return { id, value: parseRate(rateValue(input)) };
}

const tokens = {
  runtime: "example-runtime",
  model: "example-model",
  input: 1000,
  cached_input: 600,
  cache_write: 100,
  output: 200,
  reasoning: 50,
};

test("list price prices each token class and labels the number", () => {
  const rate = pinned("rate-1", 2);
  expect(listPrice(tokens, rate)).toEqual({
    basis: "list-price equivalent",
    cost: (1000 * 2 + 600 * 0.5 + 100 * 4 + 200 * 20) / 1000000,
    currency: "XXX",
    reason: null,
    rate_revision_id: "rate-1",
  });
});

test("reasoning is inside output and is not priced again", () => {
  const rate = pinned("rate-1", 2);
  expect(listPrice({ ...tokens, reasoning: 5000 }, rate).cost).toBe(
    listPrice({ ...tokens, reasoning: 0 }, rate).cost,
  );
});

test("a null token class adds nothing", () => {
  const rate = pinned("rate-1", 2);
  expect(listPrice({ ...tokens, cache_write: null }, rate).cost).toBe(
    (1000 * 2 + 600 * 0.5 + 200 * 20) / 1000000,
  );
});

test("a model with no price, a null model, and no rate are unpriced", () => {
  const rate = pinned("rate-1", 2);
  const unpriced = {
    basis: "list-price equivalent",
    cost: null,
    currency: null,
    reason: "unpriced",
  };
  expect(listPrice({ ...tokens, model: "other-model" }, rate)).toEqual({
    ...unpriced,
    rate_revision_id: "rate-1",
  });
  expect(listPrice({ ...tokens, runtime: "other-runtime" }, rate)).toEqual({
    ...unpriced,
    rate_revision_id: "rate-1",
  });
  expect(listPrice({ ...tokens, model: null }, rate)).toEqual({
    ...unpriced,
    rate_revision_id: "rate-1",
  });
  expect(listPrice(tokens, null)).toEqual({
    ...unpriced,
    rate_revision_id: null,
  });
});

test("the example rate file validates and names no real runtime or model", () => {
  const file = parse(readFileSync("specs/rate/rate.example.yaml", "utf8")) as {
    kind: string;
    name: string;
    scope: string;
    value: { prices: { runtime: string; model: string }[] };
  };
  expect(file).toMatchObject({
    kind: "rate",
    name: "default",
    scope: "global",
  });
  expect(validateRate(file.value)).toBeNull();
  for (const price of file.value.prices)
    expect([price.runtime, price.model]).toEqual(["example", "example"]);
});

describeDb("usage cost", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());

  beforeEach(async () => {
    await clearDb(conn);
    await seedConfig(conn.db);
  });

  async function activateRate(expected: string, value: Json) {
    const revision = await storeRevision(
      conn.db,
      envelope("rate", "default", value),
    );
    const moved = await conn.db.activate({
      scope: "global",
      scope_ref: "",
      kind: "rate",
      name: "default",
      expected,
      revision_id: revision.id,
      bundle_id: null,
      activated_by: "person:operator",
      activated_at: at,
    });
    if (!moved.ok) throw new Error("rate did not activate");
    return revision;
  }

  async function record(
    owner: Pick<NewUsageRecord, "attribution" | "dispatch_id" | "run_id">,
    session: string,
  ) {
    const opKey = `usage:${session}`;
    await conn.db.insertOperation({
      op_key: opKey,
      intent: "usage",
      owner_generation: 0,
      at,
    });
    return conn.db.insertUsageRecord({
      ...tokens,
      session_id: session,
      calls: 1,
      first_at: at,
      through: at,
      ...owner,
      coverage: "measured",
      op_key: opKey,
      created_at: at,
    });
  }

  async function seatDispatch(dispatchId: string) {
    await conn.db.insertOperation({
      op_key: `launch:${dispatchId}`,
      intent: "dispatch",
      owner_generation: 1,
      at,
    });
    await conn.db.insertDispatch({
      dispatch_id: dispatchId,
      task_id: null,
      decision_id: null,
      run_id: "run_1",
      seat: "example-seat",
      role: "decider",
      requested_launch: {},
      effective_launch: null,
      model_attribution: "unknown",
      retry_of: null,
      op_key: `launch:${dispatchId}`,
      settlement: "open",
      terminal_handle: null,
      created_at: at,
      settled_at: null,
      activity: "running",
      manifest_id: null,
      prompt_bytes: null,
    });
  }

  test("a Run keeps its pinned rate after a new rate is activated", async () => {
    const first = await activeRevision(
      conn.db,
      "rate",
      "default",
      rateValue(2),
    );
    await createRun(conn);
    expect((await conn.db.getSnapshot("run_1"))?.rate_revision_id).toBe(
      first.id,
    );
    await seatDispatch("d_1");
    const byPath = await record(
      { attribution: "path", dispatch_id: null, run_id: "run_1" },
      "s-path",
    );
    const byLocator = await record(
      { attribution: "locator", dispatch_id: "d_1", run_id: null },
      "s-seat",
    );
    const loose = await record(
      { attribution: "unattributed", dispatch_id: null, run_id: null },
      "s-loose",
    );
    const atFirst = listPrice(tokens, pinned(first.id, 2));
    expect(await usageCost(conn.db, byPath)).toEqual(atFirst);
    expect(await usageCost(conn.db, byLocator)).toEqual(atFirst);
    expect(await usageCost(conn.db, loose)).toEqual(atFirst);

    const second = await activateRate(first.id, rateValue(3));
    expect((await conn.db.getSnapshot("run_1"))?.rate_revision_id).toBe(
      first.id,
    );
    expect(await usageCost(conn.db, byPath)).toEqual(atFirst);
    expect(await usageCost(conn.db, byLocator)).toEqual(atFirst);
    expect(await usageCost(conn.db, loose)).toEqual(
      listPrice(tokens, pinned(second.id, 3)),
    );
  });

  test("a Run created with no active rate pins none, and its cost is unpriced", async () => {
    await createRun(conn);
    expect((await conn.db.getSnapshot("run_1"))?.rate_revision_id).toBeNull();
    await activeRevision(conn.db, "rate", "default", rateValue(2));
    const row = await record(
      { attribution: "path", dispatch_id: null, run_id: "run_1" },
      "s-path",
    );
    expect(await usageCost(conn.db, row)).toMatchObject({
      cost: null,
      reason: "unpriced",
      rate_revision_id: null,
    });
  });

  test("an unattributed row with no active rate is unpriced", async () => {
    const row = await record(
      { attribution: "unattributed", dispatch_id: null, run_id: null },
      "s-loose",
    );
    expect(await usageCost(conn.db, row)).toMatchObject({
      cost: null,
      reason: "unpriced",
    });
  });

  function rateFile(name: string, body: Record<string, unknown>): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        kind: "rate",
        name: "default",
        schema_version: 1,
        scope: "global",
        scope_ref: "",
        value: rateValue(2),
        ...body,
      }),
    );
    return path;
  }

  test("an agent apply of a rate stays pending until a person activates it", async () => {
    const applied = runCli(
      ["config", "apply", rateFile("rate.yaml", {}), "--ticket", "TRK-1"],
      seat,
    );
    expect(applied.status, applied.json.error?.message).toBe(0);
    const written = applied.json.result as {
      id: string;
      ref: string;
      activation: unknown;
      pending: { op_key: string } | null;
    };
    expect(written.activation).toBeNull();
    expect(written.pending).not.toBeNull();
    expect(
      await conn.db.getActivation({
        scope: "global",
        scope_ref: "",
        kind: "rate",
        name: "default",
      }),
    ).toBeNull();

    const args = [
      "config",
      "activate",
      written.ref,
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ];
    const refused = runCli(args, seat);
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");

    const done = runCli(args);
    expect(done.status, done.json.error?.message).toBe(0);
    expect(
      await conn.db.getActivation({
        scope: "global",
        scope_ref: "",
        kind: "rate",
        name: "default",
      }),
    ).toMatchObject({ revision_id: written.id });
    expect(
      (await conn.db.getOperation(written.pending?.op_key ?? ""))?.status,
    ).toBe("done");
  });

  test.each([
    ["a project scope", { scope: "project", scope_ref: "p" }, "scope"],
    ["another name", { name: "other" }, "name"],
    [
      "a lowercase currency",
      { value: { ...(rateValue(2) as object), currency: "xxx" } },
      "currency",
    ],
    [
      "a repeated runtime and model",
      {
        value: {
          currency: "XXX",
          prices: [
            ...(rateValue(2) as { prices: Json[] }).prices,
            ...(rateValue(3) as { prices: Json[] }).prices,
          ],
        },
      },
      "prices.1",
    ],
    [
      "a negative price",
      {
        value: {
          currency: "XXX",
          prices: [
            {
              ...((rateValue(2) as { prices: object[] }).prices[0] ?? {}),
              output: -1,
            },
          ],
        },
      },
      "prices.0.output",
    ],
  ])("a rate with %s is schema_invalid naming the field", (_, body, field) => {
    const refused = runCli([
      "config",
      "apply",
      rateFile(`bad-${field}.yaml`, body),
    ]);
    expect(refused.status).toBe(2);
    expect(refused.json.error?.code).toBe("schema_invalid");
    expect(refused.json.error?.nextSteps[0]).toBe(field);
  });
});
