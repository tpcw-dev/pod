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

export function renderBriefHtml(resultJson: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Brief</title>",
    "<style>body{font:16px/1.4 sans-serif}pre{white-space:pre-wrap}</style>",
    "</head>",
    "<body>",
    `<pre id="brief-json">${escapeHtml(resultJson)}</pre>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
