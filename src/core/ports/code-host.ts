import { z } from "zod";

export const PrState = z.object({
  number: z.int(),
  state: z.enum(["open", "merged", "closed"]),
  head_branch: z.string(),
  head_sha: z.string(),
  merge_commit: z.string().nullable(),
});
export type PrState = z.infer<typeof PrState>;

export interface CodeHostPort {
  pr(repo: string, number: number): Promise<PrState | null>;
  openPrs(repo: string, branch: string): Promise<number[] | null>;
}
