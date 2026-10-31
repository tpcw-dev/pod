import { z } from "zod";
import { TestResult } from "../domain/ledger.ts";

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

function cell(value: string): string {
  return `<td>${escapeHtml(value)}</td>`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function testTables(resultJson: string): string {
  let parsed: unknown;
  try {
    parsed = parseJson(resultJson);
  } catch {
    return "";
  }
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
            cell(row.timeout_seconds === null ? "" : String(row.timeout_seconds)) +
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

export function renderBriefHtml(resultJson: string): string {
  const tables = testTables(resultJson);
  return page(
    "Brief",
    [["brief-json", resultJson]],
    tables === "" ? "" : tables,
  );
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
