import { spawnSync } from "node:child_process";
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
