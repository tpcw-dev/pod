import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issue } from "../linear/issue.ts";

function entry(
  method: string,
  operation: string,
  variables: Record<string, unknown>,
  data: unknown,
) {
  return {
    method,
    match: { operation, variables },
    status: 200,
    body: JSON.stringify({ data }),
    error: null,
    recordedAt: "2026-11-10T00:00:00.000Z",
  };
}

function readback(story: string, bodies: readonly string[]) {
  return [
    entry(
      "readback",
      "Story",
      { id: story },
      {
        issue: issue({ identifier: story }),
      },
    ),
    entry(
      "readback",
      "StoryComments",
      { id: story, after: null },
      {
        issue: {
          comments: {
            nodes: bodies.map((body, i) => ({
              id: `c-${i + 1}`,
              body,
              editedAt: null,
              user: { id: "bot" },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ),
  ];
}

export function closeCommentTracker(story: string, body: string): string {
  const entries = [
    ...readback(story, []),
    entry(
      "postComment",
      "PostComment",
      { issueId: story },
      {
        commentCreate: {
          success: true,
          comment: { id: "c-1", body, editedAt: null, user: { id: "bot" } },
        },
      },
    ),
    ...readback(story, [body]),
  ];
  const dir = mkdtempSync(join(tmpdir(), "pod-close-tracker-"));
  for (const [i, row] of entries.entries())
    writeFileSync(
      join(dir, `${String(i + 1).padStart(3, "0")}-${row.method}.json`),
      JSON.stringify(row),
    );
  return dir;
}

export function closeBody(actor: string, runId: string): string {
  return [
    `${actor}: closed Run ${runId}`,
    "",
    "Worktree: not removed",
    "Branches removed: not removed",
    "Remote branches kept: not removed",
    "Learnings: none",
    "p0: none",
    "Retro due: no",
  ].join("\n");
}
