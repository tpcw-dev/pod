import { z } from "zod";
import type {
  BranchOutcome,
  PlannedWorktree,
  WorktreeOutcome,
} from "../domain/close.ts";
import type { Dispatch, Event } from "../domain/ledger.ts";
import type { Refusal } from "../domain/outcome.ts";
import { dispatchSelector, dispatchWorktree } from "../dispatch/retry.ts";
import type { CodeHostPort, PrState } from "../ports/code-host.ts";
import type { Repo } from "../ports/db.ts";
import type { GitPort } from "../ports/git.ts";
import type { OrcaPort } from "../ports/orca.ts";

const protectedNames: readonly string[] = ["main", "master", "staging"];

export async function planWorktrees(
  db: Repo,
  dispatches: readonly Dispatch[],
  host: string,
  git: GitPort,
): Promise<PlannedWorktree[]> {
  const plan: PlannedWorktree[] = [];
  for (const row of dispatches) {
    const selector = dispatchSelector(row);
    const path = dispatchWorktree(row);
    if (selector === null || path === null) continue;
    if (plan.some((planned) => planned.selector === selector)) continue;
    if ((await db.dispatchEvent(row.dispatch_id, "start"))?.host !== host)
      continue;
    const checkout = await git.checkout(path);
    plan.push({
      selector,
      path,
      repo: checkout?.repo ?? null,
      branch: checkout?.branch ?? null,
      tip: checkout?.tip ?? null,
    });
  }
  return plan;
}

const PrNumber = z.looseObject({ number: z.int() });

interface PrRead {
  number: number;
  repo: string | null;
  state: PrState | null;
}

function repoFor(
  event: Event,
  dispatches: readonly Dispatch[],
  plan: readonly PlannedWorktree[],
): string | null {
  const dispatch = dispatches.find(
    (row) => row.dispatch_id === event.dispatch_id,
  );
  const selector = dispatch === undefined ? null : dispatchSelector(dispatch);
  const own = plan.find((row) => row.selector === selector)?.repo ?? null;
  if (own !== null) return own;
  const repos = [
    ...new Set(plan.flatMap((row) => (row.repo === null ? [] : [row.repo]))),
  ];
  return repos.length === 1 ? (repos[0] ?? null) : null;
}

export async function readPrs(
  events: readonly Event[],
  dispatches: readonly Dispatch[],
  plan: readonly PlannedWorktree[],
  codeHost: CodeHostPort,
): Promise<PrRead[]> {
  const reads: PrRead[] = [];
  for (const event of events) {
    const parsed = PrNumber.safeParse(event.payload);
    if (!parsed.success) continue;
    const number = parsed.data.number;
    if (reads.some((read) => read.number === number)) continue;
    const repo = repoFor(event, dispatches, plan);
    reads.push({
      number,
      repo,
      state: repo === null ? null : await codeHost.pr(repo, number),
    });
  }
  return reads;
}

export async function openPrRefusal(
  reads: readonly PrRead[],
  plan: readonly PlannedWorktree[],
  codeHost: CodeHostPort,
  again: string,
): Promise<Refusal | null> {
  const found: string[] = [];
  for (const read of reads) {
    if (read.repo === null)
      found.push(
        `PR #${read.number}: no local repository is recorded for its Dispatch's worktree`,
      );
    else if (read.state === null)
      found.push(`PR #${read.number}: the code host could not be read`);
    else if (read.state.state === "open")
      found.push(`merge or close PR #${read.number}, then run the close again`);
  }
  for (const row of plan) {
    if (row.repo === null || row.branch === null) continue;
    const open = await codeHost.openPrs(row.repo, row.branch);
    if (open === null)
      found.push(
        `branch ${row.branch}: the code host could not list its open PRs`,
      );
    else
      for (const number of open)
        found.push(`merge or close PR #${number}, then run the close again`);
  }
  if (found.length === 0) return null;
  return {
    code: "open_pr",
    message: "the close cannot prove that no PR of the Run is open",
    nextSteps: [...new Set(found), again],
  };
}

export async function removeWorktrees(
  orca: OrcaPort,
  plan: readonly PlannedWorktree[],
  reviewed: ReadonlySet<string>,
  again: string,
): Promise<WorktreeOutcome[] | Refusal> {
  const outcomes: WorktreeOutcome[] = [];
  for (const row of plan) {
    const receipt = await orca.worktreeRemove({
      worktree: row.selector,
      force: reviewed.has(row.path),
    });
    if (receipt.exitCode === 0 && receipt.result?.removed === true) {
      outcomes.push({ path: row.path, removed: true, via: "removed" });
      continue;
    }
    const error = OrcaError.safeParse(receipt.raw).data?.error;
    if (error?.code === "selector_not_found") {
      outcomes.push({ path: row.path, removed: true, via: "absent" });
      continue;
    }
    return {
      code: "failed",
      message:
        `orca worktree rm ${row.selector} exited ${receipt.exitCode}: ${error?.code ?? "no error code"} ${error?.message ?? ""}`.trim(),
      nextSteps: [again],
    };
  }
  return outcomes;
}

const OrcaError = z.looseObject({
  error: z.looseObject({
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});

const sha7 = (sha: string) => sha.slice(0, 7);

interface BranchContext {
  git: GitPort;
  codeHost: CodeHostPort;
  reads: readonly PrRead[];
  integration: Map<string, Promise<string | null>>;
  fetched: Map<string, Promise<boolean>>;
}

function keptBoth(branch: string, reason: string): BranchOutcome {
  return {
    branch,
    local: "kept",
    remote: "kept",
    local_reason: reason,
    remote_reason: reason,
    pr: null,
  };
}

function once<T>(
  cache: Map<string, Promise<T>>,
  repo: string,
  read: () => Promise<T>,
): Promise<T> {
  const seen = cache.get(repo);
  if (seen !== undefined) return seen;
  const next = read();
  cache.set(repo, next);
  return next;
}

type Side = Pick<BranchOutcome, "local" | "local_reason">;

async function localSide(
  ctx: BranchContext,
  repo: string,
  branch: string,
  head: string,
  pr: number,
): Promise<Side> {
  const kept = (reason: string): Side => ({
    local: "kept",
    local_reason: reason,
  });
  const tip = await ctx.git.localTip(repo, branch);
  if (tip === null) return { local: "absent", local_reason: null };
  const checked = await ctx.git.checkedOut(repo);
  if (checked === null) return kept("worktree list unreadable");
  const path = checked.get(branch);
  if (path !== undefined) return kept(`checked out in ${path}`);
  if (tip !== head)
    return kept(
      `local tip ${sha7(tip)} differs from merged PR #${pr} head ${sha7(head)}`,
    );
  const deleted = await ctx.git.deleteLocal(repo, branch, head);
  return deleted.ok
    ? { local: "removed", local_reason: null }
    : kept(deleted.reason);
}

async function remoteSide(
  ctx: BranchContext,
  repo: string,
  branch: string,
  head: string,
): Promise<Pick<BranchOutcome, "remote" | "remote_reason">> {
  const kept = (reason: string) => ({
    remote: "kept" as const,
    remote_reason: reason,
  });
  if (!(await once(ctx.fetched, repo, () => ctx.git.fetch(repo))))
    return kept("fetch failed");
  const tip = await ctx.git.remoteTip(repo, branch);
  if (tip === null) return { remote: "absent", remote_reason: null };
  if (tip !== head) return kept(`remote moved to ${sha7(tip)}`);
  const deleted = await ctx.git.deleteRemote(repo, branch, tip);
  return deleted.ok
    ? { remote: "removed", remote_reason: null }
    : kept(`push failed: ${deleted.reason}`);
}

async function branchOutcome(
  ctx: BranchContext,
  repo: string,
  branch: string,
): Promise<BranchOutcome> {
  const integration = await once(ctx.integration, repo, () =>
    ctx.git.integration(repo),
  );
  if (integration === null) return keptBoth(branch, "integration unreadable");
  if (protectedNames.includes(branch) || branch === integration)
    return keptBoth(branch, "protected branch");
  const proof = ctx.reads.find(
    (read) =>
      read.repo === repo &&
      read.state?.state === "merged" &&
      read.state.head_branch === branch,
  );
  if (proof?.state == null)
    return keptBoth(
      branch,
      ctx.reads.some((read) => read.state === null)
        ? "code host unreadable"
        : "no merged PR proves it",
    );
  const open = await ctx.codeHost.openPrs(repo, branch);
  if (open === null) return keptBoth(branch, "code host unreadable");
  if (open.length > 0) return keptBoth(branch, `open PR #${open.join(", #")}`);
  const head = proof.state.head_sha;
  return {
    branch,
    ...(await localSide(ctx, repo, branch, head, proof.number)),
    ...(await remoteSide(ctx, repo, branch, head)),
    pr: proof.number,
  };
}

function candidates(
  plan: readonly PlannedWorktree[],
  reads: readonly PrRead[],
): { repo: string; branch: string }[] {
  const found: { repo: string; branch: string }[] = [];
  const add = (repo: string | null, branch: string | null | undefined) => {
    if (repo === null || branch == null) return;
    if (found.some((row) => row.repo === repo && row.branch === branch)) return;
    found.push({ repo, branch });
  };
  for (const row of plan) add(row.repo, row.branch);
  for (const read of reads)
    if (read.state?.state === "merged") add(read.repo, read.state.head_branch);
  return found;
}

export async function removeBranches(
  git: GitPort,
  codeHost: CodeHostPort,
  plan: readonly PlannedWorktree[],
  reads: readonly PrRead[],
  partial: readonly BranchOutcome[],
  save: (outcomes: readonly BranchOutcome[]) => Promise<void>,
): Promise<BranchOutcome[]> {
  const ctx: BranchContext = {
    git,
    codeHost,
    reads,
    integration: new Map(),
    fetched: new Map(),
  };
  const outcomes: BranchOutcome[] = [];
  for (const { repo, branch } of candidates(plan, reads)) {
    const recorded = partial.find((row) => row.branch === branch);
    if (recorded !== undefined) {
      outcomes.push(recorded);
      continue;
    }
    outcomes.push(await branchOutcome(ctx, repo, branch));
    await save(outcomes);
  }
  return outcomes;
}

function list(entries: readonly string[], separator: string): string {
  return entries.length === 0 ? "none" : entries.join(separator);
}

export function worktreeField(outcomes: readonly WorktreeOutcome[]): string {
  return outcomes.length === 0
    ? "none"
    : `removed ${outcomes.map((row) => row.path).join(", ")}`;
}

export function branchesRemovedField(
  outcomes: readonly BranchOutcome[],
): string {
  return list(
    outcomes
      .filter(
        (row) =>
          row.remote !== "kept" &&
          (row.local === "removed" || row.remote === "removed"),
      )
      .map((row) =>
        row.local === "kept"
          ? `${row.branch} (local kept: ${row.local_reason ?? ""})`
          : row.branch,
      ),
    ", ",
  );
}

export function remoteKeptField(outcomes: readonly BranchOutcome[]): string {
  return list(
    outcomes
      .filter((row) => row.remote === "kept")
      .map((row) => {
        const local =
          row.local === "kept"
            ? `local kept: ${row.local_reason ?? ""}`
            : `local ${row.local}`;
        return `${row.branch} (${row.remote_reason ?? ""}; ${local})`;
      }),
    "; ",
  );
}

export function keptLines(outcomes: readonly BranchOutcome[]): string[] {
  return outcomes.flatMap((row) => [
    ...(row.local === "kept"
      ? [`branch_kept ${row.branch} (local): ${row.local_reason ?? ""}`]
      : []),
    ...(row.remote === "kept"
      ? [`branch_kept ${row.branch} (remote): ${row.remote_reason ?? ""}`]
      : []),
  ]);
}
