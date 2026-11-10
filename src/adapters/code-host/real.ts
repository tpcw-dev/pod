import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { CodeHostPort, PrState } from "../../core/ports/code-host.ts";

const PrView = z.looseObject({
  number: z.int(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  headRefName: z.string(),
  headRefOid: z.string(),
  mergeCommit: z.looseObject({ oid: z.string() }).nullable(),
});

const PrList = z.array(z.looseObject({ number: z.int() }));

function gh(repo: string, args: readonly string[]): unknown {
  const result = spawnSync("gh", [...args], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

export const realCodeHost: CodeHostPort = {
  pr(repo, number) {
    const parsed = PrView.safeParse(
      gh(repo, [
        "pr",
        "view",
        String(number),
        "--json",
        "number,state,headRefName,headRefOid,mergeCommit",
      ]),
    );
    if (!parsed.success) return Promise.resolve(null);
    const view = parsed.data;
    const state: PrState = {
      number: view.number,
      state: view.state === "OPEN" ? "open" : view.state === "MERGED" ? "merged" : "closed",
      head_branch: view.headRefName,
      head_sha: view.headRefOid,
      merge_commit: view.mergeCommit?.oid ?? null,
    };
    return Promise.resolve(state);
  },
  openPrs(repo, branch) {
    const parsed = PrList.safeParse(
      gh(repo, [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number",
      ]),
    );
    return Promise.resolve(
      parsed.success ? parsed.data.map((row) => row.number) : null,
    );
  },
};
