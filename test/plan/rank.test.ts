import { describe, expect, test } from "vitest";
import type { PlanPayload } from "../../src/core/domain/plan.ts";
import { inForce, type InForce } from "../../src/core/plan/overrides.ts";
import { rankPlan, type PlanStory } from "../../src/core/plan/rank.ts";
import type { UsageGate } from "../../src/core/plan/usage.ts";
import type { ActiveProcess } from "../../src/core/process/select.ts";
import { listedStory } from "../db/fake-tracker.ts";

const none: InForce = { holds: [], priority: null, order: null };

const impl: ActiveProcess = {
  name: "impl",
  rev: 1,
  revisionId: "rev-impl",
  selector: { stage: "impl", size: ["xs", "s", "m"] },
};

function story(key: string, over: Partial<PlanStory> = {}): PlanStory {
  return {
    ...listedStory({
      ref: { provider: "linear", external_id: key },
      title: `Story ${key}`,
    }),
    project: "pod",
    current: "M2 Operate",
    ...over,
  };
}

function ranked(stories: PlanStory[], overrides: InForce = none) {
  return rankPlan({
    stories,
    overrides,
    activations: [impl],
    reserved: {},
    providers: {},
    usage: [],
  });
}

function keys(stories: PlanStory[], overrides: InForce = none): string[] {
  return ranked(stories, overrides).ranked.map((entry) => entry.key);
}

const day = "2026-11-15";
const later = "2026-11-16T08:00:00.000Z";

function overrideEvents(payloads: PlanPayload[]) {
  return payloads.map((payload, index) => ({
    id: index + 1,
    ts: new Date("2026-11-15T18:00:00.000Z"),
    op_key: `k${index}`,
    payload,
  }));
}

const common = { host: "local", day, actor: "person:human" };

describe("ranking layers", () => {
  test("the operator order comes first", () => {
    const overrides = inForce(
      overrideEvents([
        {
          kind: "order",
          ...common,
          until: null,
          expires_at: later,
          keys: ["TPC-9"],
        },
      ]),
      new Date("2026-11-15T20:00:00.000Z"),
    );
    expect(
      keys([story("TPC-1", { priority: 1 }), story("TPC-9")], overrides),
    ).toEqual(["TPC-9", "TPC-1"]);
  });

  test("the day's project priority comes before tracker priority", () => {
    const overrides = inForce(
      overrideEvents([
        {
          kind: "priority",
          ...common,
          until: null,
          expires_at: later,
          projects: ["process"],
        },
      ]),
      new Date("2026-11-15T20:00:00.000Z"),
    );
    expect(
      keys(
        [
          story("TPC-1", { priority: 1 }),
          story("TPC-2", { project: "process", priority: 4 }),
        ],
        overrides,
      ),
    ).toEqual(["TPC-2", "TPC-1"]);
  });

  test("tracker priority 1 urgent ranks before 4 low", () => {
    expect(
      keys([story("TPC-1", { priority: 4 }), story("TPC-2", { priority: 1 })]),
    ).toEqual(["TPC-2", "TPC-1"]);
  });

  test("place: current, then another milestone, then unlisted", () => {
    expect(
      keys([
        story("TPC-1", { milestone: null }),
        story("TPC-2", { milestone: "M3 Grow" }),
        story("TPC-3", { milestone: "M2 Operate" }),
      ]),
    ).toEqual(["TPC-3", "TPC-2", "TPC-1"]);
  });

  test("fewer points rank first", () => {
    expect(
      keys([
        story("TPC-1", { points: 3, size: "m" }),
        story("TPC-2", { points: 1, size: "xs" }),
      ]),
    ).toEqual(["TPC-2", "TPC-1"]);
  });

  test("earlier creation ranks first", () => {
    expect(
      keys([
        story("TPC-1", { createdAt: "2026-11-03T00:00:00.000Z" }),
        story("TPC-2", { createdAt: "2026-11-02T00:00:00.000Z" }),
      ]),
    ).toEqual(["TPC-2", "TPC-1"]);
  });

  test("the key breaks the last tie by its number", () => {
    expect(keys([story("TPC-10"), story("TPC-9")])).toEqual([
      "TPC-9",
      "TPC-10",
    ]);
  });

  test("an expired order no longer applies", () => {
    const events = overrideEvents([
      {
        kind: "order",
        ...common,
        until: null,
        expires_at: later,
        keys: ["TPC-9"],
      },
    ]);
    const stories = [story("TPC-1", { priority: 1 }), story("TPC-9")];
    expect(
      keys(stories, inForce(events, new Date("2026-11-16T09:00:00.000Z"))),
    ).toEqual(["TPC-1", "TPC-9"]);
  });

  test("an entry carries its project, place, driver, and reasons", () => {
    const [entry] = ranked([
      story("TPC-1", { milestone: "M2 Operate" }),
    ]).ranked;
    expect(entry).toEqual({
      key: "TPC-1",
      project: "pod",
      title: "Story TPC-1",
      points: 2,
      place: "current",
      priority: 3,
      driver: "jako",
      seats: [],
      reasons: ["tracker priority 3", "place current"],
    });
  });
});

describe("held reasons", () => {
  function reason(over: Partial<PlanStory>, overrides: InForce = none) {
    const result = ranked([story("TPC-1", over)], overrides);
    expect(result.ranked).toEqual([]);
    return result.held[0]?.reason;
  }

  test("a blocked label", () => {
    expect(reason({ labels: ["blocked"] })).toBe("label blocked");
  });

  test("a needs-jerry label", () => {
    expect(reason({ labels: ["needs-jerry"] })).toBe("label needs-jerry");
  });

  test("points outside 1 to 3", () => {
    expect(reason({ points: 5, size: "l" })).toBe("points 5");
    expect(reason({ points: null, size: null })).toBe("points none");
  });

  test("points with no size on the policy's estimate scale", () => {
    expect(reason({ points: 2, size: null })).toBe("size none");
  });

  test("no tracker priority", () => {
    expect(reason({ priority: null })).toBe("priority none");
  });

  test("an open blocker", () => {
    expect(reason({ blockers: ["TPC-7", "TPC-8"] })).toBe(
      "blocked by TPC-7, TPC-8",
    );
  });

  test("no stage label", () => {
    expect(reason({ stageLabel: null })).toBe("stage none");
  });

  test("no process the selector picks for its stage and size", () => {
    expect(reason({ stageLabel: "design" })).toBe("process selector_none");
  });

  test("a hold in force, with its project", () => {
    const overrides = inForce(
      overrideEvents([
        {
          kind: "hold",
          ...common,
          until: null,
          expires_at: later,
          key: "TPC-1",
          reason: "waits on a fix",
          project: "pod",
        },
      ]),
      new Date("2026-11-15T20:00:00.000Z"),
    );
    expect(ranked([story("TPC-1")], overrides).held).toEqual([
      { key: "TPC-1", reason: "waits on a fix", project: "pod" },
    ]);
  });

  test("a hold on a key that is not a candidate stays held", () => {
    const overrides = inForce(
      overrideEvents([
        {
          kind: "hold",
          ...common,
          until: null,
          expires_at: later,
          key: "TPC-5",
          reason: "waits",
        },
      ]),
      new Date("2026-11-15T20:00:00.000Z"),
    );
    expect(ranked([story("TPC-1")], overrides)).toMatchObject({
      ranked: [{ key: "TPC-1" }],
      held: [{ key: "TPC-5", reason: "waits" }],
    });
  });

  test("a parked Story is neither ranked nor held", () => {
    expect(ranked([story("TPC-1", { milestone: "Parked" })])).toEqual({
      ranked: [],
      held: [],
      reserved: [],
    });
  });
});

describe("reserved slots", () => {
  test("a reserved project covers its first ranked Stories", () => {
    const result = rankPlan({
      stories: [
        story("TPC-1", { project: "process", priority: 2 }),
        story("TPC-2", { priority: 1 }),
        story("TPC-3", { project: "process", priority: 3 }),
        story("TPC-4", { project: "process", priority: 4 }),
      ],
      overrides: none,
      activations: [impl],
      reserved: { process: 2, quant: 1 },
      providers: {},
      usage: [],
    });
    expect(result.reserved).toEqual([
      { project: "process", slots: 2, covers: ["TPC-1", "TPC-3"] },
      { project: "quant", slots: 1, covers: [] },
    ]);
  });
});

function gate(provider: string, state: UsageGate["state"]): UsageGate {
  return { provider, state, value: null, pace: null, observation_id: null };
}

function gated(usage: UsageGate[]) {
  return rankPlan({
    stories: [story("TPC-1"), story("TPC-2", { project: "quant" })],
    overrides: none,
    activations: [impl],
    reserved: {},
    providers: { pod: ["claude", "grok"], quant: ["codex"] },
    usage,
  });
}

describe("usage gating", () => {
  test("a Story whose crew needs a provider with no headroom is held", () => {
    const result = gated([
      gate("claude", "available"),
      gate("grok", "held"),
      gate("codex", "available"),
    ]);
    expect(result.held).toEqual([
      { key: "TPC-1", reason: "usage: grok", project: "pod" },
    ]);
    expect(result.ranked.map((entry) => entry.key)).toEqual(["TPC-2"]);
  });

  test("an unknown reading does not hold and marks the entry", () => {
    const result = gated([
      gate("claude", "unknown"),
      gate("grok", "available"),
      gate("codex", "available"),
    ]);
    expect(result.held).toEqual([]);
    expect(
      result.ranked.find((entry) => entry.key === "TPC-1")?.reasons,
    ).toContain("usage unknown: claude");
    expect(
      result.ranked.find((entry) => entry.key === "TPC-2")?.reasons,
    ).not.toContain("usage unknown: claude");
  });

  test("a reset mark in force does not hold", () => {
    const result = gated([
      gate("claude", "available"),
      gate("grok", "reset"),
      gate("codex", "available"),
    ]);
    expect(result.held).toEqual([]);
  });
});
