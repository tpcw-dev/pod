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

const states = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
} as const;

const PrList = z.array(z.looseObject({ number: z.int() }));

const prFields = "number,state,headRefName,headRefOid,mergeCommit";

function gh(cwd: string | undefined, args: readonly string[]): unknown {
  const result = spawnSync("gh", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

export const realCodeHost: CodeHostPort = {
  pr(target) {
    if ("url" in target && !target.url.startsWith("https://"))
      return Promise.resolve(null);
    const parsed = PrView.safeParse(
      "url" in target
        ? gh(undefined, ["pr", "view", target.url, "--json", prFields])
        : gh(target.repo, [
            "pr",
            "view",
            String(target.number),
            "--json",
            prFields,
          ]),
    );
    if (!parsed.success) return Promise.resolve(null);
    const view = parsed.data;
    const state: PrState = {
      number: view.number,
      state: states[view.state],
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
