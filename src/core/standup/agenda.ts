import { z } from "zod";
import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";

export const sectionNames = [
  "digest",
  "needs_human",
  "groom",
  "plan",
  "guardrails",
] as const;
export type SectionName = (typeof sectionNames)[number];

export const AgendaSection = z.discriminatedUnion("state", [
  z.object({ name: z.enum(sectionNames), state: z.literal("unknown") }),
  z.object({ name: z.enum(sectionNames), state: z.literal("none") }),
  z.object({
    name: z.enum(sectionNames),
    state: z.literal("open"),
    items: z.array(z.string()),
  }),
]);
export type AgendaSection = z.infer<typeof AgendaSection>;

export interface BriefAgendaSlice {
  projects: readonly {
    project: string;
    digest: {
      proposals: readonly { number: number; theme: string; ruling: string }[];
    };
  }[];
  tick: { needs_human: readonly { kind: string; text: string }[] } | null;
  plan: {
    hosts: readonly { host: string; ranked: readonly { key: string }[] }[];
    refused: readonly { host: string; code: string }[];
  };
}

function section(name: SectionName, items: string[]): AgendaSection {
  return items.length === 0
    ? { name, state: "none" }
    : { name, state: "open", items };
}

export function agendaOf(source: BriefAgendaSlice): AgendaSection[] {
  const sources: Record<SectionName, string[] | null> = {
    digest: source.projects.flatMap((row) =>
      row.digest.proposals
        .filter((proposal) => proposal.ruling === "open")
        .map(
          (proposal) => `${row.project} #${proposal.number} ${proposal.theme}`,
        ),
    ),
    needs_human: (source.tick?.needs_human ?? []).map(
      (line) => `${line.kind}: ${line.text}`,
    ),
    groom: null,
    plan: [
      ...source.plan.hosts.flatMap((row) =>
        row.ranked.map((entry) => `${row.host}: ${entry.key}`),
      ),
      ...source.plan.refused.map((row) => `${row.host}: refused ${row.code}`),
    ],
    guardrails: null,
  };
  return sectionNames.map((name) => {
    const items = sources[name];
    return items === null ? { name, state: "unknown" } : section(name, items);
  });
}

export function agendaHash(agenda: readonly AgendaSection[]): string {
  return sha256Hex(canonicalJson(agenda));
}
