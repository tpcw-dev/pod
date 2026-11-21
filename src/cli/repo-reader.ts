import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CheckRun,
  CheckState,
  Hit,
  RepoReader,
} from "../core/ports/repo-reader.ts";

function git(repo: string, ...args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function must(repo: string, ...args: string[]): string {
  const result = git(repo, ...args);
  if (result.status !== 0)
    throw new Error(
      `git ${args[0] ?? ""} in ${repo} exited ${result.status}: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  return result.stdout;
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exit: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exit: timedOut ? null : code, stderr, timedOut });
    });
  });
}

function stateOf(
  exit: number | null,
  stderr: string,
  wrote: boolean,
): CheckState {
  if (wrote) return "writes";
  if (exit === 127 || stderr.includes("can't open file")) return "missing";
  return exit === 0 ? "passes" : "fails";
}

export const realRepoReader: RepoReader = {
  resolve(repo, ref) {
    const result = git(repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`);
    return Promise.resolve(result.status === 0 ? result.stdout.trim() : null);
  },
  grep(repo, sha, under, pattern) {
    const flag =
      "word" in pattern ? ["-w", "-e", pattern.word] : ["-F", "-e", pattern.fixed];
    const result = git(repo, "grep", "-n", ...flag, sha, "--", ...under);
    if (result.status === 1) return Promise.resolve([]);
    if (result.status !== 0)
      throw new Error(
        `git grep in ${repo} exited ${result.status}: ${result.stderr.trim()}`,
      );
    const hits: Hit[] = [];
    for (const row of result.stdout.split("\n")) {
      if (!row.startsWith(`${sha}:`)) continue;
      const rest = row.slice(sha.length + 1);
      const match = /^(.*?):(\d+):(.*)$/.exec(rest);
      if (match === null) continue;
      hits.push({
        path: match[1] ?? "",
        line: Number(match[2]),
        text: match[3] ?? "",
      });
    }
    return Promise.resolve(hits);
  },
  show(repo, sha, path) {
    const result = git(repo, "show", `${sha}:${path}`);
    return Promise.resolve(result.status === 0 ? result.stdout : null);
  },
  exists(repo, sha, path) {
    return Promise.resolve(
      git(repo, "cat-file", "-e", `${sha}:${path}`).status === 0,
    );
  },
  async runCheck(repo, sha, command, timeoutMs): Promise<CheckRun> {
    const dir = mkdtempSync(join(tmpdir(), "proves-"));
    try {
      must(repo, "worktree", "add", "--quiet", "--detach", dir, sha);
      const ran = await run(command, dir, timeoutMs);
      if (ran.timedOut) return { command, state: "timeout", exit: null };
      const wrote =
        must(dir, "status", "--porcelain", "--untracked-files=all").trim() !==
        "";
      return { command, state: stateOf(ran.exit, ran.stderr, wrote), exit: ran.exit };
    } finally {
      git(repo, "worktree", "remove", "--force", dir);
      git(repo, "worktree", "prune");
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
