import type {
  GatesSection,
  StateGatesView,
  StateView,
} from "../domain/state.ts";
import type { TickLines } from "../domain/tick.ts";

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

function refText(ref: { name: string; rev: number } | null): string {
  return ref === null ? "none" : `${ref.name}@${ref.rev}`;
}

function tickLines(tick: TickLines | null): string[] {
  if (tick === null) return [];
  return tick.needs_human.map(
    (line) =>
      `tick ${tick.event_id} ${line.kind} story ${line.story} ${line.run_id} since ${line.since}: ${line.text}`,
  );
}

function gateLines(gates: GatesSection): string[] {
  const head = `run ${gates.run_id} ${gates.run_state}`;
  if (gates.status === "process_unreadable")
    return [head, `status process_unreadable: ${gates.detail}`];
  if (gates.items.length === 0) return [head, "no gated steps"];
  return [
    head,
    ...gates.items.map((item) => {
      const receipt = item.receipt;
      const outcome =
        receipt === null
          ? "no receipt"
          : `${receipt.outcome} ${receipt.candidate_sha} deployed ${receipt.deployed_revision ?? "none"} at ${receipt.created_at}`;
      return `${item.gate} step ${item.step} ${item.type ?? "untyped"} keeper ${item.keeper ?? "none"} task ${item.task_id ?? "none"} ${item.task_state ?? "none"}: ${outcome}`;
    }),
  ];
}

type Entry = [string, Stamp | null, string[]];

function runsEntry({ runs }: StateGatesView): Entry {
  return [
    "Active Runs",
    runs,
    orNone(
      runs.runs.map(
        (run) =>
          `${run.run_id} story ${run.story} ${run.state} generation ${run.owner_generation} process ${run.source_revision ?? "none"}: ${
            run.waiting_on.length === 0
              ? "waiting on nothing"
              : run.waiting_on.join("; ")
          }`,
      ),
    ),
  ];
}

function gatesEntry(view: StateGatesView): Entry[] {
  if (view.scope.story === null) return [];
  if (view.gates === null) return [["Gates", null, ["none"]]];
  return [["Gates", view.gates, gateLines(view.gates)]];
}

function sectionLines(sections: Entry[]): string[] {
  return sections.flatMap(([heading, stamp, body]) => [
    `## ${heading}`,
    ...(stamp === null ? [] : [stampLine(stamp)]),
    ...body,
    "",
  ]);
}

export function renderStateGates(view: StateGatesView): string {
  return sectionLines([runsEntry(view), ...gatesEntry(view)])
    .join("\n")
    .trimEnd();
}

export function renderState(view: StateView): string {
  const { roadmap, policies, decisions, usage, needs_human, learnings } = view;
  const sections: Entry[] = [
    ["Roadmap", roadmap, roadmapLines(view)],
    runsEntry(view),
    ...gatesEntry(view),
    [
      "Policies in force and Reserved categories",
      policies,
      [
        revisionLine("policy", policies.policy),
        `Profile: ${policies.profile ?? "none"} (policy ${refText(policies.policy)})`,
        ...policies.pending_profile.map(
          (row) =>
            `Profile pending: ${row.profile} (policy ${row.policy}), post ${JSON.stringify(row.comment)}`,
        ),
        `Config requests pending: ${policies.pending_requests}`,
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
            `${row.provider} ${row.value} (${row.coverage}) window ${row.window ?? "none"} observed ${row.observed_at ?? "never"}`,
        ),
      ),
    ],
    [
      "Open needs-human items",
      needs_human,
      orNone([
        ...needs_human.items.map(
          (item) =>
            `${item.open ? "open" : "closed"} story ${item.story} ${item.run_id} ${item.task_id} gate ${item.gate} keeper ${item.keeper}: ${item.reason}`,
        ),
        ...tickLines(needs_human.tick),
      ]),
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
  const lines = sectionLines(sections);
  if (view.truncated) lines.push("truncated");
  lines.push(...view.routing.map((line) => `routing: ${line}`));
  return lines.join("\n").trimEnd();
}
