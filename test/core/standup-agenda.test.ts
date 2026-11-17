import { expect, test } from "vitest";
import {
  agendaOf,
  type BriefAgendaSlice,
} from "../../src/core/standup/agenda.ts";

const empty: BriefAgendaSlice = {
  projects: [],
  tick: null,
  plan: { hosts: [], refused: [] },
  groom: { stories: [] },
  guardrails: [],
};

test("an empty day is clear in every section, in the fixed order", () => {
  expect(agendaOf(empty)).toEqual([
    { name: "digest", state: "none" },
    { name: "needs_human", state: "none" },
    { name: "groom", state: "none" },
    { name: "plan", state: "none" },
    { name: "guardrails", state: "none" },
  ]);
});

test("an unread groom queue is unknown", () => {
  expect(agendaOf({ ...empty, groom: null })[2]).toEqual({
    name: "groom",
    state: "unknown",
  });
});

test("a full day fills all five sections", () => {
  const agenda = agendaOf({
    projects: [
      {
        project: "widgets",
        digest: {
          proposals: [
            { number: 1, theme: "tests", ruling: "open" },
            { number: 2, theme: "docs", ruling: "accept" },
          ],
        },
      },
    ],
    tick: { needs_human: [{ kind: "run_hold", text: "Run run-1 is on hold" }] },
    plan: {
      hosts: [
        { host: "local", ranked: [{ key: "S-1" }], published: { event_id: 1 } },
        { host: "spare", ranked: [], published: null },
      ],
      refused: [{ host: "other", code: "config_missing" }],
    },
    groom: {
      stories: [
        { project: "widgets", external_id: "S-7", title: "Sort the list" },
      ],
    },
    guardrails: [
      { name: "drained", sunset_candidate: false },
      { name: "usage_hold", sunset_candidate: true },
    ],
  });
  expect(agenda).toEqual([
    { name: "digest", state: "open", items: ["widgets #1 tests"] },
    {
      name: "needs_human",
      state: "open",
      items: ["run_hold: Run run-1 is on hold"],
    },
    { name: "groom", state: "open", items: ["widgets S-7 Sort the list"] },
    {
      name: "plan",
      state: "open",
      items: [
        "local: S-1",
        "spare: no published plan today",
        "other: refused config_missing",
      ],
    },
    { name: "guardrails", state: "open", items: ["usage_hold: 0 in 30 days"] },
  ]);
});
