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

function page(title: string, blocks: readonly [string, string][]): string {
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
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function renderBriefHtml(resultJson: string): string {
  return page("Brief", [["brief-json", resultJson]]);
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
