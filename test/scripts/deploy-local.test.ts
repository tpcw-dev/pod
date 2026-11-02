import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/deploy-local.sh", import.meta.url),
);

let root: string;
let work: string;
let calls: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function deploy() {
  return spawnSync("bash", [join(work, "scripts/deploy-local.sh")], {
    cwd: work,
    encoding: "utf8",
    env,
  });
}

function tags(cwd: string): string {
  return git(cwd, "tag", "--list");
}

function pnpmCalls(): string[] {
  return readFileSync(calls, "utf8").split("\n").filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pod-deploy-"));
  const bin = join(root, "bin");
  calls = join(root, "pnpm-calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1" = --version ] && echo stub\nexit 0\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const stub = spawnSync("pnpm", ["--version"], { encoding: "utf8", env });
  expect(stub.stdout.trim()).toBe("stub");
  writeFileSync(calls, "");
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  work = join(root, "work");
  git(root, "clone", "-q", "origin.git", "work");
  mkdirSync(join(work, "scripts"));
  copyFileSync(script, join(work, "scripts/deploy-local.sh"));
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "pod", version: "1.2.3" }),
  );
  git(work, "checkout", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");
});

test("a branch that is not origin/main is refused before any tag", () => {
  git(work, "checkout", "-q", "-b", "feature");
  git(work, "commit", "-q", "--allow-empty", "-m", "ahead");
  const result = deploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/^refused: HEAD [0-9a-f]{40} is not origin\/main/m);
  expect(tags(work)).toBe("");
  expect(pnpmCalls()).toEqual([]);
});

test("a dirty tree is refused before any tag", () => {
  writeFileSync(join(work, "stray.txt"), "x");
  const result = deploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("refused: working tree is not clean");
  expect(tags(work)).toBe("");
});

test("an annotated tag of the version at another commit is refused, locally or on origin only", () => {
  const base = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", "v1.2.3", "-m", "old");
  git(work, "commit", "-q", "--allow-empty", "-m", "next");
  git(work, "push", "-q", "origin", "main");
  const local = deploy();
  expect(local.status).not.toBe(0);
  expect(local.stderr).toContain(`refused: tag v1.2.3 exists at ${base}`);
  git(work, "push", "-q", "origin", "v1.2.3");
  git(work, "tag", "-d", "v1.2.3");
  const remote = deploy();
  expect(remote.status).not.toBe(0);
  expect(remote.stderr).toContain(`refused: tag v1.2.3 exists at ${base}`);
  expect(pnpmCalls()).toEqual([]);
});

test("a fresh deploy tags, pushes, builds, links, and prints the four deploy fields", () => {
  const head = git(work, "rev-parse", "HEAD");
  const result = deploy();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(git(work, "rev-parse", "v1.2.3^{commit}")).toBe(head);
  expect(git(work, "cat-file", "-t", "v1.2.3")).toBe("tag");
  expect(git(join(root, "origin.git"), "rev-parse", "v1.2.3^{commit}")).toBe(
    head,
  );
  expect(pnpmCalls()).toEqual(["build", "link --global"]);
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  expect(JSON.parse(last)).toEqual({
    environment: "local",
    deployment_id: "v1.2.3",
    deployed_revision: head,
    source_commit: head,
  });
});

test("a run stopped after the local tag resumes: it pushes the tag and finishes", () => {
  const head = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", "v1.2.3", "-m", "pod v1.2.3");
  const result = deploy();
  expect(result.status).toBe(0);
  expect(git(join(root, "origin.git"), "rev-parse", "v1.2.3^{commit}")).toBe(
    head,
  );
  expect(pnpmCalls()).toEqual(["build", "link --global"]);
});
