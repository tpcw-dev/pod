import { expect, test } from "vitest";
import { happenedOf, windowSince } from "../../src/core/brief/happened.ts";
import type { Event } from "../../src/core/domain/ledger.ts";
import { wallInstant } from "../../src/core/plan/clock.ts";

const at = new Date("2026-11-17T08:00:00.000Z");

let id = 0;
function event(
  type: Event["type"],
  payload: Record<string, unknown>,
  runId: string | null = "run-1",
): Event {
  id += 1;
  return {
    id,
    type,
    ts: at,
    host: "local",
    run_id: runId,
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload,
    source: {},
  } as Event;
}

test("wallInstant reads a host clock time on a host day as an instant", () => {
  expect(
    wallInstant("2026-11-16", "21:30", "America/Los_Angeles").toISOString(),
  ).toBe("2026-11-17T05:30:00.000Z");
  expect(
    wallInstant("2026-07-01", "00:00", "America/Los_Angeles").toISOString(),
  ).toBe("2026-07-01T07:00:00.000Z");
  expect(wallInstant("2026-11-16", "09:00", "UTC").toISOString()).toBe(
    "2026-11-16T09:00:00.000Z",
  );
});

test("since is the newest standup, else the previous host day's pause_at, else its midnight", () => {
  const now = new Date("2026-11-17T18:00:00.000Z");
  const standup = new Date("2026-11-17T06:00:00.000Z");
  const zone = "America/Los_Angeles";
  expect(windowSince({ standup, pauseAt: "21:00", now, zone })).toEqual(
    standup,
  );
  expect(
    windowSince({ standup: null, pauseAt: "21:00", now, zone }).toISOString(),
  ).toBe("2026-11-17T05:00:00.000Z");
  expect(
    windowSince({ standup: null, pauseAt: null, now, zone }).toISOString(),
  ).toBe("2026-11-16T08:00:00.000Z");
});

test("happened sorts the window's events into closed runs, prs, deploys, gates, stops, and ticks", () => {
  const events = [
    event("close", { op_key: "close:run-1" }),
    event("close", { op_key: "close:run-gone" }, "run-gone"),
    event("pr", {
      number: 12,
      url: "https://code.example/pr/12",
      head: "a".repeat(40),
    }),
    event("deploy", {
      task_id: "task-1",
      environment: "production",
      deployment_id: "d-1",
      deployed_revision: "rev-9",
      source_commit: "b".repeat(40),
    }),
    event("receipt", { receipt_id: 3, gate: "review", outcome: "PASS" }),
    event("receipt", {
      receipt_id: 4,
      gate: "hqa",
      outcome: "FAIL",
      comment_id: "c",
    }),
    event("receipt", { verb: "issue", endedAt: at.toISOString() }),
    event("hold", { reason: "launch_unknown", from: "dispatched" }),
    event("hold", { from: "dispatched" }),
    event("escalate", { story: "S-1", kind: "p0", text: "a p0 leftover" }),
    event("tick", {
      host: "local",
      tick_id: "tick-1",
      actor: "seat:tick",
      schedule_revision: "rev",
      plan_event: null,
      overrides: [],
      triggers: [],
      steps: [{ step: "launch", op_key: "k", result: "failed", detail: null }],
      launch: [],
      refuse: [],
      needs_human: [],
    }),
    event("tick", { broken: true }),
    event("learning", {}),
  ];
  const happened = happenedOf(events, new Map([["run-1", "S-1"]]));
  expect(happened.closed_runs).toEqual([
    {
      event_id: events[0]?.id,
      ts: at.toISOString(),
      run_id: "run-1",
      story: "S-1",
    },
    {
      event_id: events[1]?.id,
      ts: at.toISOString(),
      run_id: "run-gone",
      story: null,
    },
  ]);
  expect(happened.prs).toMatchObject([
    { number: 12, url: "https://code.example/pr/12" },
  ]);
  expect(happened.deploys).toMatchObject([
    { environment: "production", deployed_revision: "rev-9" },
  ]);
  expect(happened.gates.map((row) => [row.gate, row.outcome])).toEqual([
    ["review", "PASS"],
    ["hqa", "FAIL"],
  ]);
  expect(happened.stops.map((row) => [row.type, row.text])).toEqual([
    ["hold", "launch_unknown"],
    ["hold", null],
    ["escalate", "a p0 leftover"],
  ]);
  expect(happened.ticks).toMatchObject([
    { tick_id: "tick-1", host: "local", result: "failed", needs_human: [] },
  ]);
  expect(happened).toMatchObject({
    velocity: "unknown",
    tokens_per_point: "unknown",
    minutes_per_point: "unknown",
  });
});
