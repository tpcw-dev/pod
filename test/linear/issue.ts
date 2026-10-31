export function issue(over: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "TRK-1",
    title: "A Story",
    description: "Goal\n\nKickoff: impl-small@1",
    estimate: 3,
    state: { id: "st-backlog", name: "Backlog", type: "backlog" },
    labels: { nodes: [{ name: "stage:impl" }, { name: "meta" }] },
    team: {
      id: "team-1",
      key: "TRK",
      states: {
        nodes: [
          { id: "st-backlog", name: "Backlog", type: "backlog" },
          { id: "st-doing", name: "Doing", type: "started" },
          { id: "st-canceled", name: "Canceled", type: "canceled" },
        ],
      },
    },
    ...over,
  };
}
