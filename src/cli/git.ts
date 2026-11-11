import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { WorktreeStatus } from "../core/domain/close.ts";
import type { GitPort, GitWrite } from "../core/ports/git.ts";
import { PodError } from "./errors.ts";

export function gitStatus(path: string): string {
  const result = spawnSync(
    "git",
    ["-C", path, "status", "--porcelain=v1", "--branch"],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new PodError(
      "failed",
      1,
      `git status in ${path} failed: ${(result.stderr || result.error?.message || "").trim()}`,
      ["check that the Dispatch's worktree still exists on this host"],
    );
  return result.stdout.trimEnd();
}

export function parseWorktreeStatus(text: string): WorktreeStatus {
  const [head = "", ...entries] = text.split("\n");
  const ahead = /\[ahead (\d+)/.exec(head);
  return {
    files: entries
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3)),
    ahead: ahead === null ? 0 : Number(ahead[1]),
  };
}

export function worktreeStatus(path: string): WorktreeStatus | null {
  if (!existsSync(path)) return null;
  return parseWorktreeStatus(gitStatus(path));
}

export function gitTree(sha: string): Promise<string | null> {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`],
    { encoding: "utf8" },
  );
  return Promise.resolve(result.status === 0 ? result.stdout.trim() : null);
}

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function text(cwd: string, ...args: string[]): string | null {
  const result = git(cwd, ...args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function written(result: ReturnType<typeof git>): GitWrite {
  if (result.status === 0) return { ok: true };
  const line = (result.stderr || result.error?.message || "")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row !== "" && !row.startsWith("To "));
  return { ok: false, reason: line ?? `git exited ${result.status}` };
}

export function parseCheckedOut(porcelain: string): Map<string, string> {
  const found = new Map<string, string>();
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path !== null)
      found.set(line.slice("branch refs/heads/".length), path);
  }
  return found;
}

export const realGit: GitPort = {
  checkout(path) {
    if (!existsSync(path)) return Promise.resolve(null);
    const common = text(
      path,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    if (common === null) return Promise.resolve(null);
    return Promise.resolve({
      repo: dirname(common),
      branch: text(path, "symbolic-ref", "--short", "-q", "HEAD"),
      tip: text(path, "rev-parse", "--verify", "-q", "HEAD"),
    });
  },
  integration(repo) {
    const ref = text(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD");
    const prefix = "refs/remotes/origin/";
    return Promise.resolve(
      ref?.startsWith(prefix) === true ? ref.slice(prefix.length) : null,
    );
  },
  fetch(repo) {
    return Promise.resolve(
      git(repo, "fetch", "--prune", "origin").status === 0,
    );
  },
  localTip(repo, branch) {
    return Promise.resolve(
      text(repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`),
    );
  },
  remoteTip(repo, branch) {
    return Promise.resolve(
      text(
        repo,
        "rev-parse",
        "--verify",
        "-q",
        `refs/remotes/origin/${branch}`,
      ),
    );
  },
  checkedOut(repo) {
    const listed = text(repo, "worktree", "list", "--porcelain");
    return Promise.resolve(listed === null ? null : parseCheckedOut(listed));
  },
  deleteLocal(repo, branch, sha) {
    return Promise.resolve(
      written(git(repo, "update-ref", "-d", `refs/heads/${branch}`, sha)),
    );
  },
  deleteRemote(repo, branch, sha) {
    const ref = `refs/heads/${branch}`;
    return Promise.resolve(
      written(
        git(
          repo,
          "push",
          "origin",
          `--force-with-lease=${ref}:${sha}`,
          `:${ref}`,
        ),
      ),
    );
  },
};
