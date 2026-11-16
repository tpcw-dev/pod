import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { scheduleRefusal } from "../../src/core/config/schedule.ts";
import type { RevisionEnvelope } from "../../src/core/domain/config.ts";
import { clearDb, describeDb, openDb, resetDb, runCli } from "../db/helpers.ts";

const seedPath = "specs/schedule/default.yaml";
const seed = parse(readFileSync(seedPath, "utf8")) as RevisionEnvelope;
const dir = mkdtempSync(join(tmpdir(), "pod-schedule-"));
const seat = { POD_SEAT: "developer" };

function refusedAt(change: Partial<RevisionEnvelope>) {
  const refusal = scheduleRefusal({ ...seed, ...change });
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
}

function scheduleFile(change: Partial<RevisionEnvelope>): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, stringify({ ...seed, ...change }));
  return path;
}

test("the seed is a host-scope schedule Revision named default that passes its schema", () => {
  expect(seed).toMatchObject({
    kind: "schedule",
    name: "default",
    scope: "host",
  });
  expect(scheduleRefusal(seed)).toBeNull();
});

test("another name, another scope, or a bad value is schema_invalid naming the field", () => {
  expect(refusedAt({ name: "fast" })).toEqual(["schema_invalid", "name"]);
  expect(refusedAt({ scope: "global", scope_ref: "" })).toEqual([
    "schema_invalid",
    "scope",
  ]);
  expect(refusedAt({ value: { tick_minutes: 0, hold_minutes: 60 } })).toEqual([
    "schema_invalid",
    "tick_minutes",
  ]);
  expect(refusedAt({ value: { tick_minutes: 15 } })).toEqual([
    "schema_invalid",
    "hold_minutes",
  ]);
  expect(
    refusedAt({ value: { tick_minutes: 15, hold_minutes: 60, extra: 1 } }),
  ).toEqual(["schema_invalid", "extra"]);
});

test("the seed carries one morning meta slot at 05:00 with retro and digest", () => {
  expect(seed.value).toMatchObject({
    meta_slots: [{ name: "morning", at: "05:00", steps: ["retro", "digest"] }],
  });
});

test("a bad meta slot is schema_invalid naming its path, and meta_slots may be absent", () => {
  const base = { tick_minutes: 15, hold_minutes: 60 };
  const slot = { name: "morning", at: "05:00", steps: ["retro"] };
  expect(refusedAt({ value: base })).toBeNull();
  expect(
    refusedAt({
      value: { ...base, meta_slots: [{ ...slot, steps: ["retro", "log"] }] },
    }),
  ).toEqual(["schema_invalid", "meta_slots.0.steps.1"]);
  expect(
    refusedAt({ value: { ...base, meta_slots: [{ ...slot, at: "5:00" }] } }),
  ).toEqual(["schema_invalid", "meta_slots.0.at"]);
  expect(
    refusedAt({ value: { ...base, meta_slots: [{ ...slot, at: "24:00" }] } }),
  ).toEqual(["schema_invalid", "meta_slots.0.at"]);
  expect(
    refusedAt({ value: { ...base, meta_slots: [{ ...slot, steps: [] }] } }),
  ).toEqual(["schema_invalid", "meta_slots.0.steps"]);
  expect(
    refusedAt({
      value: { ...base, meta_slots: [{ ...slot, steps: ["retro", "retro"] }] },
    }),
  ).toEqual(["schema_invalid", "meta_slots.0.steps"]);
  expect(refusedAt({ value: { ...base, meta_slots: [slot, slot] } })).toEqual([
    "schema_invalid",
    "meta_slots",
  ]);
  expect(
    refusedAt({ value: { ...base, meta_slots: [{ ...slot, when: "x" }] } }),
  ).toEqual(["schema_invalid", "meta_slots.0.when"]);
});

describeDb("schedule kind", () => {
  let conn: Connection;

  beforeAll(async () => {
    await resetDb();
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => clearDb(conn));

  test("config apply refuses a schedule off the host scope", () => {
    const result = runCli([
      "config",
      "apply",
      scheduleFile({ scope: "global", scope_ref: "" }),
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error).toMatchObject({
      code: "schema_invalid",
      nextSteps: ["scope"],
    });
  });

  test("a Seat's schedule waits for a person, and config get reads it once activated", () => {
    const written = runCli(
      ["config", "apply", seedPath, "--ticket", "TRK-1"],
      seat,
    );
    expect(written.status, written.json.error?.message).toBe(0);
    expect(written.json.result?.["activation"]).toBeNull();
    expect(written.json.result?.["pending"]).not.toBeNull();
    const get = ["config", "get", "schedule.default", "--scope", "host:host-a"];
    expect(runCli(get).json.error?.code).toBe("config_missing");
    const activated = runCli([
      "config",
      "activate",
      written.json.result?.["ref"] as string,
      "--scope",
      "host:host-a",
      "--expected-revision",
      "none",
    ]);
    expect(activated.status, activated.json.error?.message).toBe(0);
    expect(runCli(get).json.result).toMatchObject({
      scope: "host",
      scope_ref: "host-a",
      value: { tick_minutes: 15, hold_minutes: 60 },
    });
  });
});
