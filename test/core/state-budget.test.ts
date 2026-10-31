import { expect, test } from "vitest";
import type { StateView } from "../../src/core/domain/state.ts";
import { fitBudget } from "../../src/core/state/budget.ts";
import { renderState } from "../../src/core/state/render.ts";

const observed_at = "2026-10-31T00:00:00.000Z";
const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

function view(
  sizes: {
    milestones?: number;
    learnings?: number;
    closed?: number;
    reserved?: number;
  } = {},
): StateView {
  return {
    scope: { story: "S-1", project: "pod" },
    roadmap: {
      status: "ok",
      page: "page-1",
      source_revision: "policy-rev",
      observed_at,
      current: ["M2 build"],
      milestones: [
        { text: "M2 build", current: true },
        ...Array.from({ length: sizes.milestones ?? 2 }, (_, i) => ({
          text: `M${i + 3} ${words(4, "m")}`,
          current: false,
        })),
      ],
    },
    runs: {
      source_revision: null,
      observed_at,
      runs: [
        {
          run_id: "run_1",
          story: "S-1",
          state: "active",
          source_revision: "process-rev",
          waiting_on: ["gate review keeper reviewer-seat"],
        },
      ],
    },
    policies: {
      source_revision: "policy-rev",
      observed_at,
      policy: { id: "policy-rev", name: "default", rev: 1 },
      crew: { id: "crew-rev", name: "default", rev: 1 },
      reserved: {
        deny: ["live_trading", words(sizes.reserved ?? 0, "r")].filter(
          (row) => row !== "",
        ),
        needs_human: ["spend"],
        needs_existing_authorization: ["repo_create: story_spec"],
      },
    },
    decisions: {
      source_revision: null,
      observed_at,
      decisions: [
        {
          id: "dec-1",
          scope: "global",
          question: "keep the budget",
          outcome: "agreed",
          decided_at: observed_at,
          in_force_until: null,
          standing: true,
        },
      ],
    },
    usage: {
      source_revision: null,
      observed_at,
      providers: [
        {
          provider: "claude",
          value: "unknown",
          coverage: "no_source",
          observed_at,
        },
      ],
    },
    needs_human: {
      source_revision: null,
      observed_at,
      items: [
        {
          story: "S-1",
          run_id: "run_1",
          task_id: "task_open",
          gate: "hqa_after_deploy",
          keeper: "human-gatekeeper",
          open: true,
          reason: "awaiting hqa_after_deploy PASS or FAIL from human-gatekeeper",
          at: observed_at,
        },
        ...Array.from({ length: sizes.closed ?? 1 }, (_, i) => ({
          story: "S-1",
          run_id: "run_1",
          task_id: `task_closed_${i}`,
          gate: "hqa_after_deploy",
          keeper: "human-gatekeeper",
          open: false,
          reason: `PASS recorded ${words(10, "c")}`,
          at: observed_at,
        })),
      ],
    },
    learnings: {
      source_revision: null,
      observed_at,
      learnings: Array.from({ length: sizes.learnings ?? 2 }, (_, i) => ({
        id: 1000 - i,
        text: `learning ${i} ${words(4, "l")}`,
        area: "impl",
        source_story: "S-1",
        created_at: observed_at,
      })),
    },
    truncated: false,
    routing: [],
  };
}

function count(state: StateView): number {
  return renderState(state).match(/\S+/g)?.length ?? 0;
}

function protectedParts(state: StateView) {
  return {
    runs: state.runs,
    policies: state.policies,
    decisions: state.decisions,
    open: state.needs_human.items.filter((item) => item.open),
    current:
      state.roadmap.status === "ok"
        ? state.roadmap.milestones.filter((row) => row.current)
        : [],
  };
}

const milestonesLine = "pod docs read --page page-1 --heading Milestones";
const learningsLine = "pod learning query --adoption adopted --project pod";
const needsHumanLine = "pod brief story:S-1";

test("a view under the budget comes back unchanged", () => {
  const small = view();
  expect(count(small)).toBeLessThan(3000);
  expect(fitBudget(small, 3000)).toEqual(small);
});

test("a view over the budget trims non-current milestones before any learning", () => {
  const big = view({ milestones: 400, learnings: 250 });
  expect(count(big)).toBeGreaterThan(3000);
  const fitted = fitBudget(big, 3000);
  expect(count(fitted)).toBeLessThanOrEqual(3000);
  expect(fitted.truncated).toBe(true);
  expect(fitted.routing).toEqual([milestonesLine]);
  expect(fitted.learnings).toEqual(big.learnings);
  expect(fitted.needs_human).toEqual(big.needs_human);
  expect(protectedParts(fitted)).toEqual(protectedParts(big));
  const kept = fitted.roadmap.status === "ok" ? fitted.roadmap.milestones : [];
  expect(kept.length).toBeGreaterThan(1);
  expect(kept.length).toBeLessThan(401);
});

test("past the milestones it trims the oldest learnings, then the oldest closed needs-human items", () => {
  const big = view({ milestones: 50, learnings: 600, closed: 250 });
  const fitted = fitBudget(big, 3000);
  expect(count(fitted)).toBeLessThanOrEqual(3000);
  expect(fitted.truncated).toBe(true);
  expect(fitted.routing).toEqual([
    milestonesLine,
    learningsLine,
    needsHumanLine,
  ]);
  expect(protectedParts(fitted)).toEqual(protectedParts(big));
  expect(fitted.roadmap.status === "ok" && fitted.roadmap.milestones).toEqual([
    { text: "M2 build", current: true },
  ]);
  expect(fitted.learnings.learnings).toEqual([]);
  const closed = fitted.needs_human.items.filter((item) => !item.open);
  expect(closed.length).toBeGreaterThan(0);
  expect(closed).toEqual(
    big.needs_human.items.filter((item) => !item.open).slice(0, closed.length),
  );
});

test("a view over the budget from protected sections alone keeps every one of them", () => {
  const big = view({ milestones: 0, learnings: 0, closed: 0, reserved: 4000 });
  const fitted = fitBudget(big, 3000);
  expect(count(fitted)).toBeGreaterThan(3000);
  expect(fitted).toEqual(big);
});

test("routing lines from the sections stay ahead of the trim lines", () => {
  const big = { ...view({ milestones: 600 }), routing: ["set POD_X"] };
  expect(fitBudget(big, 3000).routing).toEqual(["set POD_X", milestonesLine]);
});
