import { expect, test } from "vitest";
import {
  errorClasses,
  errorCodes,
  guardrailCodes,
} from "../../src/cli/errors.ts";
import { guardrailsOf } from "../../src/core/brief/guardrails.ts";
import type { Event, Operation } from "../../src/core/domain/ledger.ts";

const now = new Date("2026-11-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function refused(code: unknown, at: Date, key = String(code)): Operation {
  return {
    op_key: `op-${key}-${at.toISOString()}`,
    intent: "dispatch",
    status: "refused",
    owner_generation: 1,
    result_ref: code === undefined ? { request: {} } : { request: {}, code },
    created_at: at,
    updated_at: at,
  } as Operation;
}

let id = 0;
function event(
  type: Event["type"],
  at: Date,
  payload: Record<string, unknown> = {},
): Event {
  id += 1;
  return {
    id,
    type,
    ts: at,
    host: "local",
    run_id: "run-1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload,
    source: {},
  } as Event;
}

test("every error code has a class of guardrail or data", () => {
  expect(Object.keys(errorClasses).sort()).toEqual([...errorCodes].sort());
  for (const code of errorCodes)
    expect(["guardrail", "data"]).toContain(errorClasses[code]);
  expect(guardrailCodes).toContain("drained");
  expect(guardrailCodes).not.toContain("schema_invalid");
});

test("a guardrail code with no refusal in 30 days is a sunset candidate; a data code is not listed", () => {
  const rows = guardrailsOf({
    codes: ["drained", "usage_hold"],
    reservedNeedsHuman: [],
    refused: [
      refused("drained", daysAgo(2)),
      refused("drained", daysAgo(10)),
      refused("drained", daysAgo(40)),
      refused("schema_invalid", daysAgo(1)),
    ],
    events: [],
    now,
  });
  expect(rows.find((row) => row.name === "drained")).toEqual({
    name: "drained",
    kind: "code",
    days_7: 1,
    days_30: 2,
    sunset_candidate: false,
  });
  expect(rows.find((row) => row.name === "usage_hold")).toMatchObject({
    days_30: 0,
    sunset_candidate: true,
  });
  expect(rows.map((row) => row.name)).not.toContain("schema_invalid");
});

test("a refusal with no string code or an unknown code is not counted", () => {
  const rows = guardrailsOf({
    codes: ["drained"],
    reservedNeedsHuman: [],
    refused: [
      refused(undefined, daysAgo(1)),
      refused(7, daysAgo(1)),
      refused("settled_decision", daysAgo(1)),
    ],
    events: [],
    now,
  });
  expect(rows[0]).toMatchObject({ name: "drained", days_30: 0 });
});

test("hold, escalate, and Reserved needs_human members count from events, one routing counted once", () => {
  const rows = guardrailsOf({
    codes: [],
    reservedNeedsHuman: ["deploy", "spend"],
    refused: [],
    events: [
      event("hold", daysAgo(1), { reason: "launch_unknown" }),
      event("hold", daysAgo(20), { reason: "unknown_delivery" }),
      event("escalate", daysAgo(3), { text: "p0 left" }),
      event("decision", daysAgo(2), {
        outcome: "reserved_needs_human",
        reserved: { class: "needs_human", member: "deploy" },
      }),
      event("decision", daysAgo(2), {
        outcome: "needs_human",
        reserved: { class: "needs_human", member: "deploy" },
      }),
      event("decision", daysAgo(4), {
        outcome: "reserved_needs_human",
        reserved: { class: "needs_human", member: "retired" },
      }),
      event("hold", daysAgo(31), { reason: "old" }),
    ],
    now,
  });
  expect(rows).toEqual([
    {
      name: "hold",
      kind: "hold",
      days_7: 1,
      days_30: 2,
      sunset_candidate: false,
    },
    {
      name: "escalate",
      kind: "escalate",
      days_7: 1,
      days_30: 1,
      sunset_candidate: false,
    },
    {
      name: "reserved:deploy",
      kind: "reserved",
      days_7: 1,
      days_30: 1,
      sunset_candidate: false,
    },
    {
      name: "reserved:retired",
      kind: "reserved",
      days_7: 1,
      days_30: 1,
      sunset_candidate: false,
    },
    {
      name: "reserved:spend",
      kind: "reserved",
      days_7: 0,
      days_30: 0,
      sunset_candidate: true,
    },
  ]);
});
