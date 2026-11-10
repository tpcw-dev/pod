import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { WorktreeStatus } from "../core/domain/close.ts";
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
