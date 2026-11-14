import { z } from "zod";
import { TestResult } from "../domain/ledger.ts";
import { tokenTotal } from "../usage/rollup.ts";

const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => escapes[ch] ?? ch);
}

function page(
  title: string,
  blocks: readonly [string, string][],
  after = "",
): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "<style>body{font:16px/1.4 sans-serif}pre{white-space:pre-wrap}</style>",
    "</head>",
    "<body>",
    ...blocks.map(([id, text]) => `<pre id="${id}">${escapeHtml(text)}</pre>`),
    ...(after === "" ? [] : [after]),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const BriefPending = z.object({
  pending_requests: z.array(
    z.object({
      ref: z.string(),
      scope: z.string(),
      ticket: z.string().nullable(),
      actor: z.string().nullable(),
      comment: z.string(),
    }),
  ),
});

const BriefDrift = z.object({
  drift: z.array(
    z.object({
      ref: z.string(),
      scope: z.string(),
      path: z.string().nullable(),
      mark: z.string(),
    }),
  ),
});

const BriefTables = z.object({
  stories: z.array(
    z.object({
      runs: z.array(
        z.object({
          dispatches: z.array(
            z.object({
              dispatch_id: z.string(),
              tests: z.array(TestResult).optional(),
            }),
          ),
        }),
      ),
    }),
  ),
});

const SeatRow = z.object({
  seat: z.string(),
  prompt_bytes: z.number().nullable(),
  cold_start_ms: z.number().nullable(),
});

const BriefMeasurements = z.object({
  stories: z.array(
    z.object({
      runs: z.array(
        z.object({
          run_id: z.string(),
          measurement: z.object({
            pair: z
              .object({ decider: SeatRow, auditor: SeatRow.nullable() })
              .nullable(),
            decisions: z.array(
              z.object({
                decision_id: z.string(),
                state: z.string(),
                reason: z.string().nullable(),
                effect: z.string().nullable(),
                outcome: z.string(),
              }),
            ),
            escalations: z.object({
              "policy-required": z.number(),
              disagreement: z.number(),
              "context-missing": z.number(),
              "runtime-failure": z.number(),
              worker: z.number(),
              sample: z.number(),
              target: z.number(),
            }),
          }),
        }),
      ),
    }),
  ),
});

const BriefDigest = z.object({
  projects: z.array(
    z.object({
      project: z.string(),
      digest: z.object({
        cap: z.number(),
        shown: z.number(),
        queued: z.number(),
        proposals: z.array(
          z.object({
            number: z.number(),
            theme: z.string(),
            text: z.string(),
            evidence_refs: z.array(z.string()),
            ruling: z.string(),
          }),
        ),
      }),
    }),
  ),
});

const Tokens = z.object({
  input: z.number().nullable(),
  cached_input: z.number().nullable(),
  cache_write: z.number().nullable(),
  output: z.number().nullable(),
  reasoning: z.number().nullable(),
});

const UsageCost = z.object({
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  reason: z.string().nullable(),
});

const UsageTotals = z.object({
  tokens: Tokens,
  running_minutes: z.number().nullable(),
  wall_minutes: z.number().nullable(),
  cost: UsageCost,
});

const UsagePoints = z.object({
  points_done: z.number(),
  tokens_per_point: z.number().nullable(),
  minutes_per_point: z.number().nullable(),
});

const BriefUsage = z.object({
  usage: z.object({
    day: z.string().nullable(),
    time_zone: z.string(),
    total: UsageTotals,
    points: UsagePoints,
    projects: z.array(
      UsageTotals.extend({
        project: z.string().nullable(),
        points: UsagePoints,
      }),
    ),
    unattributed: z.array(
      z.object({ runtime: z.string(), tokens: Tokens, cost: UsageCost }),
    ),
    coverage: z.object({
      tokens_source: z.object({
        locator: z.number(),
        path: z.number(),
        unattributed: z.number(),
      }),
      null_values: z.array(z.unknown()),
      no_record: z.array(z.string()),
      unknown_minutes: z.array(z.string()),
    }),
  }),
});

function cell(value: string): string {
  return `<td>${escapeHtml(value)}</td>`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function parsedJson(resultJson: string): unknown {
  try {
    return parseJson(resultJson);
  } catch {
    return null;
  }
}

function row(values: readonly string[]): string {
  return `<tr>${values.map(cell).join("")}</tr>`;
}

function optional(value: number | string | null): string {
  return value === null ? "" : String(value);
}

function measurementTables(parsed: unknown): string {
  const brief = BriefMeasurements.safeParse(parsed);
  if (!brief.success) return "";
  const tables: string[] = [];
  for (const story of brief.data.stories) {
    for (const run of story.runs) {
      const { pair, decisions, escalations } = run.measurement;
      const seats =
        pair === null
          ? []
          : [
              ["decider", pair.decider] as const,
              ...(pair.auditor === null
                ? []
                : [["auditor", pair.auditor] as const]),
            ];
      const rows = [
        row(["seat", "id", "prompt bytes", "cold start ms"]),
        ...seats.map(([role, seat]) =>
          row([
            role,
            seat.seat,
            optional(seat.prompt_bytes),
            optional(seat.cold_start_ms),
          ]),
        ),
        row(["decision", "state", "reason", "effect", "outcome"]),
        ...decisions.map((decision) =>
          row([
            decision.decision_id,
            decision.state,
            optional(decision.reason),
            optional(decision.effect),
            decision.outcome,
          ]),
        ),
        row([
          "policy-required",
          "disagreement",
          "context-missing",
          "runtime-failure",
          "worker",
          "sample",
        ]),
        row([
          String(escalations["policy-required"]),
          String(escalations.disagreement),
          String(escalations["context-missing"]),
          String(escalations["runtime-failure"]),
          String(escalations.worker),
          `${escalations.sample}/${escalations.target}`,
        ]),
      ];
      tables.push(
        `<table id="measurement-${escapeHtml(run.run_id)}">\n${rows.join("\n")}\n</table>`,
      );
    }
  }
  return tables.join("\n");
}

function known(value: number | null): string {
  return value === null ? "unknown" : String(Math.round(value * 10) / 10);
}

function costCell(cost: z.infer<typeof UsageCost>): string {
  return cost.amount === null
    ? `unknown (${cost.reason ?? "unpriced"})`
    : `${cost.amount.toFixed(4)} ${cost.currency ?? ""}`.trim();
}

function usageRow(
  name: string,
  totals: z.infer<typeof UsageTotals>,
  points: z.infer<typeof UsagePoints>,
): string {
  return row([
    name,
    known(tokenTotal(totals.tokens)),
    known(totals.running_minutes),
    known(totals.wall_minutes),
    costCell(totals.cost),
    String(points.points_done),
    known(points.tokens_per_point),
    known(points.minutes_per_point),
  ]);
}

function usageTable(parsed: unknown): string {
  const brief = BriefUsage.safeParse(parsed);
  if (!brief.success) return "";
  const { usage } = brief.data;
  const { tokens_source: source } = usage.coverage;
  const rows = [
    row([
      `usage ${usage.day ?? ""} (${usage.time_zone})`,
      "tokens",
      "running min",
      "wall min",
      "cost, list-price equivalent",
      "points",
      "tokens per point",
      "minutes per point",
    ]),
    ...usage.projects.map((project) =>
      usageRow(project.project ?? "no project", project, project.points),
    ),
    usageRow("overall", usage.total, usage.points),
    ...usage.unattributed.map((line) =>
      row([
        `unattributed ${line.runtime}`,
        known(tokenTotal(line.tokens)),
        "",
        "",
        costCell(line.cost),
        "",
        "",
        "",
      ]),
    ),
    row([
      "coverage",
      `locator ${source.locator}, path ${source.path}, unattributed ${source.unattributed}`,
      `null values ${usage.coverage.null_values.length}`,
      `no record ${usage.coverage.no_record.length}`,
      `unknown minutes ${usage.coverage.unknown_minutes.length}`,
      "",
      "",
      "",
    ]),
  ];
  return `<table id="usage">\n${rows.join("\n")}\n</table>`;
}

function testTables(parsed: unknown): string {
  const brief = BriefTables.safeParse(parsed);
  if (!brief.success) return "";
  const tables: string[] = [];
  for (const story of brief.data.stories) {
    for (const run of story.runs) {
      for (const dispatch of run.dispatches) {
        const tests = dispatch.tests ?? [];
        if (tests.length === 0) continue;
        const rows = tests.map(
          (row) =>
            "<tr>" +
            cell(row.command) +
            cell(String(row.exit_code)) +
            cell(String(row.seconds)) +
            cell(
              row.timeout_seconds === null ? "" : String(row.timeout_seconds),
            ) +
            "</tr>",
        );
        tables.push(
          `<table id="tests-${escapeHtml(dispatch.dispatch_id)}">\n${rows.join("\n")}\n</table>`,
        );
      }
    }
  }
  return tables.join("\n");
}

function digestSections(parsed: unknown): string {
  const brief = BriefDigest.safeParse(parsed);
  if (!brief.success) return "";
  return brief.data.projects
    .flatMap(({ project, digest }) => {
      const id = escapeHtml(project);
      const line = `<p id="digest-${id}">Digest ${digest.shown}/${digest.cap}, ${digest.queued} queued</p>`;
      if (digest.proposals.length === 0) return [line];
      const rows = [
        row(["number", "theme", "proposal", "evidence", "ruling"]),
        ...digest.proposals.map((proposal) =>
          row([
            String(proposal.number),
            proposal.theme,
            proposal.text,
            proposal.evidence_refs.join(" "),
            proposal.ruling,
          ]),
        ),
      ];
      return [
        line,
        `<table id="digest-proposals-${id}">\n${rows.join("\n")}\n</table>`,
      ];
    })
    .join("\n");
}

function pendingTable(parsed: unknown): string {
  const brief = BriefPending.safeParse(parsed);
  if (!brief.success || brief.data.pending_requests.length === 0) return "";
  const rows = [
    row(["Revision", "scope", "ticket", "requested by", "comment to post"]),
    ...brief.data.pending_requests.map((request) =>
      row([
        request.ref,
        request.scope,
        request.ticket ?? "the Story of a live Run",
        request.actor ?? "",
        request.comment,
      ]),
    ),
  ];
  return `<table id="pending-requests">\n${rows.join("\n")}\n</table>`;
}

function driftTable(parsed: unknown): string {
  const brief = BriefDrift.safeParse(parsed);
  if (!brief.success || brief.data.drift.length === 0) return "";
  const rows = [
    row(["Revision", "scope", "mirror path", "mark"]),
    ...brief.data.drift.map((item) =>
      row([item.ref, item.scope, item.path ?? "no safe path", item.mark]),
    ),
  ];
  return `<table id="mirror-stale">\n${rows.join("\n")}\n</table>`;
}

export function renderBriefHtml(resultJson: string): string {
  const parsed = parsedJson(resultJson);
  const tables = [
    pendingTable(parsed),
    digestSections(parsed),
    driftTable(parsed),
    testTables(parsed),
    measurementTables(parsed),
    usageTable(parsed),
  ]
    .filter((table) => table !== "")
    .join("\n");
  return page("Brief", [["brief-json", resultJson]], tables);
}

export function renderRestoreHtml(viewText: string): string {
  return page("Restore view", [["restore-view", viewText]]);
}

export function renderStateHtml(viewText: string, resultJson: string): string {
  return page("State", [
    ["state-view", viewText],
    ["state-json", resultJson],
  ]);
}
