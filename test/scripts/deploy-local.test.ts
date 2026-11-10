import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/deploy-local.sh", import.meta.url),
);
const src = fileURLToPath(new URL("../../src", import.meta.url));
const deployCalls = [
  "bin --global",
  "build --out-dir .deploy/dist",
  "node .deploy/dist/index.js db migrate",
  "link --global",
];

let root: string;
let work: string;
let calls: string;
let globalBin: string;
let migrateFails: string;
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

function stubCalls(): string[] {
  return readFileSync(calls, "utf8").split("\n").filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pod-deploy-"));
  const bin = join(root, "bin");
  calls = join(root, "calls");
  globalBin = join(root, "global-bin");
  migrateFails = join(root, "migrate-fails");
  mkdirSync(bin);
  mkdirSync(join(root, "pod-home"));
  writeFileSync(calls, "");
  writeFileSync(globalBin, join(root, "pnpm-home"));
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${calls}"`,
      '[ "$1" = --version ] && echo stub',
      `[ "$*" = "bin --global" ] && cat "${globalBin}"`,
      '[ "$1" = build ] && mkdir -p "$3" && echo new > "$3/index.js"',
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "node"),
    [
      "#!/bin/sh",
      'if [ "$1" = .deploy/dist/index.js ]; then',
      `  echo "node $*" >> "${calls}"`,
      `  [ -e "${migrateFails}" ] && exit 3`,
      `  echo '{"journal":1,"applied":1}'`,
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    POD_HOME: join(root, "pod-home"),
    POD_DB_URL: "postgres://pod.invalid/pod",
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
  symlinkSync(src, join(work, "src"));
  writeFileSync(join(work, ".gitignore"), "dist/\n");
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "pod", version: "1.2.3" }),
  );
  git(work, "checkout", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");
  mkdirSync(join(work, "dist"));
  writeFileSync(join(work, "dist/index.js"), "old\n");
});

function linkedBuild(): string {
  return readFileSync(join(work, "dist/index.js"), "utf8").trim();
}

test("a branch that is not origin/main is refused before any tag", () => {
  git(work, "checkout", "-q", "-b", "feature");
  git(work, "commit", "-q", "--allow-empty", "-m", "ahead");
  const result = deploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/^refused: HEAD [0-9a-f]{40} is not origin\/main/m);
  expect(tags(work)).toBe("");
  expect(stubCalls()).toEqual([]);
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
  expect(stubCalls()).toEqual([]);
});

test("a fresh deploy builds, migrates, links, then tags, pushes, and prints the four deploy fields", () => {
  const head = git(work, "rev-parse", "HEAD");
  const result = deploy();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('{"journal":1,"applied":1}');
  expect(result.stderr).not.toContain("refused:");
  expect(git(work, "rev-parse", "v1.2.3^{commit}")).toBe(head);
  expect(git(work, "cat-file", "-t", "v1.2.3")).toBe("tag");
  expect(git(join(root, "origin.git"), "rev-parse", "v1.2.3^{commit}")).toBe(
    head,
  );
  expect(stubCalls()).toEqual(deployCalls);
  expect(linkedBuild()).toBe("new");
  expect(existsSync(join(work, ".deploy"))).toBe(false);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    environment: "local",
    deployment_id: "v1.2.3",
    deployed_revision: head,
    source_commit: head,
  });
});

test("a run stopped after the local tag finishes on rerun: it runs every step and pushes the tag", () => {
  const head = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", "v1.2.3", "-m", "pod v1.2.3");
  const result = deploy();
  expect(result.status).toBe(0);
  expect(git(join(root, "origin.git"), "rev-parse", "v1.2.3^{commit}")).toBe(
    head,
  );
  expect(stubCalls()).toEqual(deployCalls);
});

test("no global bin directory is refused before the build and before any tag", () => {
  writeFileSync(globalBin, "");
  const result = deploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("refused: pnpm has no global bin directory");
  expect(tags(work)).toBe("");
  expect(stubCalls()).toEqual(["bin --global"]);
});

test("an unset database URL or a malformed host profile is refused before the build and before any tag", () => {
  delete env["POD_DB_URL"];
  const unset = deploy();
  expect(unset.status).not.toBe(0);
  expect(unset.stderr).toContain("refused: POD_DB_URL is not set");
  writeFileSync(join(root, "pod-home", "host.yaml"), "db: [\n");
  env["POD_DB_URL"] = "postgres://pod.invalid/pod";
  const malformed = deploy();
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).toMatch(/^refused: .*host\.yaml is not valid YAML$/m);
  expect(tags(work)).toBe("");
  expect(stubCalls()).toEqual(["bin --global", "bin --global"]);
});

test("a failed migrate is refused with db migrate failed, leaves the linked build, and writes no tag", () => {
  writeFileSync(migrateFails, "");
  const result = deploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("refused: db migrate failed");
  expect(tags(work)).toBe("");
  expect(tags(join(root, "origin.git"))).toBe("");
  expect(stubCalls()).toEqual(deployCalls.slice(0, 3));
  expect(linkedBuild()).toBe("old");
});

test("a rerun on the same HEAD runs every step again and prints the same deploy line", () => {
  const first = deploy();
  expect(first.status).toBe(0);
  const second = deploy();
  expect(second.status).toBe(0);
  expect(second.stdout).toBe(first.stdout);
  expect(git(work, "tag", "--list")).toBe("v1.2.3");
  expect(stubCalls()).toEqual([...deployCalls, ...deployCalls]);
});
