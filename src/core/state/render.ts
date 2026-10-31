import type { StateView } from "../domain/state.ts";

interface Stamp {
  source_revision: string | null;
  observed_at: string;
}

function stampLine(section: Stamp): string {
  return `source_revision ${section.source_revision ?? "none"} observed_at ${section.observed_at}`;
}

function orNone(lines: string[]): string[] {
  return lines.length === 0 ? ["none"] : lines;
}

function roadmapLines(view: StateView): string[] {
  const roadmap = view.roadmap;
  if (roadmap.status !== "ok")
    return [`status ${roadmap.status}: ${roadmap.detail}`];
  return [
    `page ${roadmap.page}`,
    ...roadmap.current.map((line) => `current: ${line}`),
    ...roadmap.milestones.map(
      (row) =>
        `${row.current ? "current milestone" : "milestone"}: ${row.text}`,
    ),
  ];
}

function revisionLine(
  label: string,
  ref: { id: string; name: string; rev: number } | null,
): string {
  return ref === null
    ? `${label} none`
    : `${label} ${ref.name}@${ref.rev} ${ref.id}`;
}

export function renderState(view: StateView): string {
  const { roadmap, runs, policies, decisions, usage, needs_human, learnings } =
    view;
  const sections: [string, Stamp, string[]][] = [
    ["Roadmap", roadmap, roadmapLines(view)],
    [
      "Active Runs",
      runs,
      orNone(
        runs.runs.map(
          (run) =>
            `${run.run_id} story ${run.story} ${run.state} process ${run.source_revision ?? "none"}: ${
              run.waiting_on.length === 0
                ? "waiting on nothing"
                : run.waiting_on.join("; ")
            }`,
        ),
      ),
    ],
    [
      "Policies in force and Reserved categories",
      policies,
      [
        revisionLine("policy", policies.policy),
        revisionLine("crew", policies.crew),
        `reserved deny: ${policies.reserved.deny.join(", ")}`,
        `reserved needs_human: ${policies.reserved.needs_human.join(", ")}`,
        `reserved needs_existing_authorization: ${policies.reserved.needs_existing_authorization.join(", ")}`,
      ],
    ],
    [
      "Applicable decisions",
      decisions,
      orNone(
        decisions.decisions.map(
          (row) =>
            `${row.id} ${row.scope} ${row.outcome}: ${row.question} (decided ${row.decided_at}, ${
              row.standing
                ? "standing"
                : `in force until ${row.in_force_until ?? "30 days after the decision"}`
            })`,
        ),
      ),
    ],
    [
      "Usage coverage",
      usage,
      orNone(
        usage.providers.map(
          (row) =>
            `${row.provider} ${row.value} (${row.coverage}) observed ${row.observed_at ?? "never"}`,
        ),
      ),
    ],
    [
      "Open needs-human items",
      needs_human,
      orNone(
        needs_human.items.map(
          (item) =>
            `${item.open ? "open" : "closed"} story ${item.story} ${item.run_id} ${item.task_id} gate ${item.gate} keeper ${item.keeper}: ${item.reason}`,
        ),
      ),
    ],
    [
      "Learnings",
      learnings,
      orNone(
        learnings.learnings.map(
          (row) => `#${row.id} ${row.area} ${row.source_story}: ${row.text}`,
        ),
      ),
    ],
  ];
  const lines = sections.flatMap(([heading, stamp, body]) => [
    `## ${heading}`,
    stampLine(stamp),
    ...body,
    "",
  ]);
  if (view.truncated) lines.push("truncated");
  lines.push(...view.routing.map((line) => `routing: ${line}`));
  return lines.join("\n").trimEnd();
}
