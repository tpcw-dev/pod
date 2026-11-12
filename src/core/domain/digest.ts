import { z } from "zod";

export const Verdict = z.enum(["accept", "reject"]);
export type Verdict = z.infer<typeof Verdict>;

export type RulingState = Verdict | "open";

const nonEmpty = z.string().min(1);

export const ProposalFileRow = z.strictObject({
  theme: nonEmpty,
  text: nonEmpty,
  learning_ids: z.array(z.int().positive()).min(1),
  evidence_refs: z.array(nonEmpty),
});
export type ProposalFileRow = z.infer<typeof ProposalFileRow>;

const ProposalFile = z.array(ProposalFileRow).superRefine((rows, ctx) => {
  const seen = new Set<number>();
  rows.forEach((row, index) => {
    const own = new Set<number>();
    for (const id of row.learning_ids) {
      if (seen.has(id) || own.has(id))
        ctx.addIssue({
          code: "custom",
          path: [index, "learning_ids"],
          message: `repeats learning ${id}`,
        });
      own.add(id);
    }
    for (const id of own) seen.add(id);
  });
});

export function acceptProposalFile(
  value: unknown,
):
  | { ok: true; proposals: ProposalFileRow[] }
  | { ok: false; issues: string[] } {
  const parsed = ProposalFile.safeParse(value);
  if (parsed.success) return { ok: true, proposals: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.flatMap((issue) => {
      const [index, ...rest] = issue.path;
      const path =
        index === undefined
          ? "proposals"
          : `proposals[${String(index)}]${rest.map((part) => `.${String(part)}`).join("")}`;
      return issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `${path}.${key}: unknown key`)
        : [`${path}: ${issue.message}`];
    }),
  };
}

export interface NewDigestProposal {
  proposal_key: string;
  scope: string;
  posted_on: string;
  theme: string;
  text: string;
  learning_ids: number[];
  evidence_refs: string[];
  created_at: Date;
}

export interface DigestProposal extends NewDigestProposal {
  id: number;
  shown_on: string | null;
  ruling: Verdict | null;
  ruled_at: Date | null;
}

export function scopeOf(project: string | null): string {
  return project === null ? "global" : `project:${project}`;
}

export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}
