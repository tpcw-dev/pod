import type { Dispatch, Run } from "../domain/ledger.ts";
import type { TranscriptLine } from "../domain/retro.ts";
import { storedLocator, transcriptPath } from "../dispatch/transcript.ts";

export interface PacketPr {
  number: number;
  state: string | null;
  merge_commit: string | null;
}

export interface PacketInput {
  run: Run;
  dispatches: readonly Dispatch[];
  prs: readonly PacketPr[];
  templates: Readonly<Record<string, string>>;
}

export function transcriptLine(
  dispatch: Dispatch,
  templates: Readonly<Record<string, string>>,
): TranscriptLine {
  const locator = storedLocator(dispatch.effective_launch);
  if (locator === null)
    return {
      dispatch_id: dispatch.dispatch_id,
      harness: null,
      session_id: null,
      path: null,
      status: "absent",
    };
  const path = transcriptPath(templates, locator);
  return {
    dispatch_id: dispatch.dispatch_id,
    harness: locator.harness,
    session_id: locator.session_id,
    path,
    status: path === null ? "unresolved" : "resolved",
  };
}

function describe(line: TranscriptLine): string {
  switch (line.status) {
    case "resolved":
      return line.path ?? "";
    case "unresolved":
      return `${line.harness} ${line.session_id}, no path for this harness on this host`;
    case "absent":
      return "absent, the launch receipt named no session id";
  }
}

export function retroPacket(input: PacketInput): {
  text: string;
  transcripts: TranscriptLine[];
} {
  const { run, dispatches, prs, templates } = input;
  const rows = dispatches.map((row) => ({
    row,
    line: transcriptLine(row, templates),
  }));
  const manifests = [
    ...new Set(dispatches.flatMap((row) => row.manifest_id ?? [])),
  ];
  const text = [
    `Retro for Run ${run.run_id}, Story ${run.story_provider}:${run.story_external_id}.`,
    `Tracker record: story:${run.story_external_id} (${run.story_provider})`,
    `Evidence manifests: ${manifests.length === 0 ? "none" : manifests.join(" ")}`,
    `Merged PRs: ${
      prs.length === 0
        ? "none"
        : prs
            .map(
              (pr) =>
                `pr:${pr.number} ${pr.state ?? "unread"} ${pr.merge_commit ?? "none"}`,
            )
            .join("; ")
    }`,
    "Transcripts:",
    ...rows.map(
      ({ row, line }) =>
        `- ${row.dispatch_id} ${row.role} ${row.seat}: ${describe(line)}`,
    ),
    `Return findings as a YAML list for \`pod retro record FILE --run ${run.run_id}\`: text, expected, area, evidence_refs (transcript:<dispatch_id>:<line>, or a manifest, pr, or story reference), wording.`,
  ].join("\n");
  return { text, transcripts: rows.map(({ line }) => line) };
}
