import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { usageFor, verbs } from "../src/cli/verbs.ts";

function run(
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): { status: number | null; stdout: string } {
  const result = spawnSync(
    "node_modules/.bin/tsx",
    ["src/cli/index.ts", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      ...(input === undefined ? {} : { input }),
    },
  );
  return { status: result.status, stdout: result.stdout };
}

test("a positional is not help", () => {
  for (const args of [
    ["--help", "extra"],
    ["extra", "--help"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "usage", nextSteps: ["pod --help"] },
    });
  }
});

test("learning, digest, and docs help exit 0", () => {
  for (const args of [
    ["learning", "add", "--help"],
    ["learning", "import", "--help"],
    ["learning", "query", "--help"],
    ["digest", "decide", "--help"],
    ["docs", "read", "--help"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  }
});

test("help lists the verbs sorted by name", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  const names = (
    JSON.parse(result.stdout) as { result: { verbs: { name: string }[] } }
  ).result.verbs.map((verb) => verb.name);
  expect(names).toEqual([...names].sort());
  expect(names).toEqual([
    "brief",
    "check",
    "config activate",
    "config apply",
    "config export",
    "config get",
    "config id",
    "config list",
    "config set",
    "db migrate",
    "decide",
    "decide cancel",
    "decide ruling",
    "deploy record",
    "digest assign",
    "digest decide",
    "digest post",
    "digest prepare",
    "digest queue",
    "dispatch",
    "docs read",
    "drain",
    "groom",
    "hqa record",
    "learning add",
    "learning import",
    "learning query",
    "log",
    "plan",
    "plan hold",
    "plan order",
    "plan priority",
    "plan release",
    "plan reset-available",
    "plan reset-used",
    "plan stretch",
    "release",
    "reply",
    "retro",
    "retro record",
    "retry",
    "run close",
    "run create",
    "run launch",
    "standup",
    "standup done",
    "standup skip",
    "state",
    "takeover",
    "tick",
    "usage",
    "usage record",
    "verdict post",
  ]);
});

test("--json on a verb that does not take it is usage", () => {
  const result = run(["learning", "query", "--json"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("usage");
});

test("a flag the verb does not take is usage", () => {
  const result = run(["db", "migrate", "--html", "out.html"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("usage");
});

test("deploy record takes one JSON deploy line from FILE or --stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-deploy-line-"));
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const deploy = ["deploy", "record", "story:S-1", "--generation", "1"];
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const line = JSON.stringify({
    environment: "local",
    deployment_id: "v0.1.1",
    deployed_revision: sha,
    source_commit: sha,
  });
  for (const [args, code, input] of [
    [deploy, "usage"],
    [[...deploy, file("both.json", line), "--stdin"], "usage", line],
    [[...deploy, "--stdin"], "schema_invalid", ""],
    [[...deploy, "--stdin"], "schema_invalid", `${line}\n${line}`],
    [
      [...deploy, file("extra.json", line.replace("}", ',"x":1}'))],
      "schema_invalid",
    ],
    [
      [...deploy, file("short.json", '{"environment":"local"}')],
      "schema_invalid",
    ],
  ] as const) {
    const result = run([...args], { POD_HOME: "/nonexistent" }, input);
    expect(result.status, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
  }
});

test("an unknown verb is usage", () => {
  const result = run(["config", "delete"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "usage", nextSteps: ["pod --help"] },
  });
});

test("a verb's usage error names the flags its input takes", () => {
  for (const args of [
    ["brief", "story:X", "--bogus"],
    ["brief", "story:X", "--json"],
    ["brief", "story:X", "extra"],
  ]) {
    const result = run(args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout), args.join(" ")).toMatchObject({
      ok: false,
      error: {
        code: "usage",
        message: "usage: brief",
        nextSteps: ["pod brief [--project] [--html] [--section]", "pod --help"],
      },
    });
  }
});

test("state --section is usage without a Story, with an unknown name, or with --html", () => {
  for (const [args, message] of [
    [
      ["state", "--section", "gates"],
      "usage: state --section gates needs story:<id>",
    ],
    [
      ["state", "story:X", "--section", "bogus"],
      "usage: state --section bogus is not a section",
    ],
    [
      ["state", "story:X", "--section", "gates", "--html", "f"],
      "usage: state --section takes no --html; the HTML page renders the whole state",
    ],
  ] as const) {
    const result = run([...args], { POD_HOME: "/nonexistent" });
    expect(result.status, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout).error, args.join(" ")).toMatchObject({
      code: "usage",
      message,
    });
  }
});

test("every verb's usage error lists its input's flags before pod --help", () => {
  const synopsis = new Map(
    verbs.map((verb) => {
      const error = usageFor(verb);
      expect(error.code).toBe("usage");
      expect(error.message).toBe(`usage: ${verb.name}`);
      expect(error.nextSteps).toHaveLength(2);
      expect(error.nextSteps[1]).toBe("pod --help");
      return [verb.name, error.nextSteps[0]];
    }),
  );
  expect(synopsis.get("db migrate")).toBe("pod db migrate");
  expect(synopsis.get("decide cancel")).toBe(
    "pod decide cancel [--generation]",
  );
  expect(synopsis.get("config activate")).toBe(
    "pod config activate [--scope] [--expected-revision] [--op-key] [--reason]",
  );
});

test("a launch lease that is not a positive whole number is usage", () => {
  for (const lease of ["0", "-5", "soon"]) {
    const result = run(["check", "--run", "run_1", "--generation", "1"], {
      POD_LAUNCH_LEASE_SECONDS: lease,
      POD_HOME: "/nonexistent",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "usage",
        message: expect.stringContaining("POD_LAUNCH_LEASE_SECONDS"),
      },
    });
  }
});

test("decide ruling prints the comment text and opens no database", () => {
  const noDb = {
    POD_HOME: mkdtempSync(join(tmpdir(), "pod-ruling-cli-")),
    POD_DATABASE_URL: "",
  };
  const result = run(["decide", "ruling", "D", "resume", "--note", "x"], noDb);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("decision D resume\nx\n");
  const cancel = run(["decide", "cancel", "D", "--generation", "1"], noDb);
  expect(cancel.status).not.toBe(0);
});

test("decide ruling refuses a verb other than resume, agreed, or cancelled", () => {
  const result = run(["decide", "ruling", "D", "maybe"]);
  expect(result.status).toBe(2);
});

test("tick --agenda takes operate or meta, and --slot needs --agenda meta", () => {
  for (const args of [
    ["tick", "--agenda", "weekly"],
    ["tick", "--slot", "morning"],
    ["tick", "--agenda", "operate", "--slot", "morning"],
    ["tick", "--agenda", "meta", "--trigger", "operator:a"],
  ]) {
    const result = run(args);
    expect(result.status, args.join(" ")).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("usage");
  }
});

const processSeed = `kind: process
name: id-check
schema_version: 1
value:
  summary: one worker step
  selector:
    stage: impl
  roles: [developer]
  steps:
    - id: build
      type: worker
      role: developer
  edges:
    - from: build
      on: done
      to: done
`;

function noDatabase(): Record<string, string> {
  return {
    POD_DB_URL: "",
    POD_HOME: mkdtempSync(join(tmpdir(), "pod-config-id-home-")),
  };
}

test("config id prints the id with no database", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-config-id-"));
  const path = join(dir, "process.yaml");
  writeFileSync(path, processSeed);
  expect(processSeed).toContain("      on: done\n");
  const env = noDatabase();
  const result = run(["config", "id", path], env);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout).result;
  expect(output.revision_id).toMatch(/^[0-9a-f]{64}$/);
  expect(output).toMatchObject({
    kind: "process",
    name: "id-check",
    schema_version: 1,
    scope: "global",
    scope_ref: "",
    parent: null,
  });
  const apply = run(["config", "apply", path], env);
  expect(apply.status).toBe(2);
  expect(JSON.parse(apply.stdout).error).toMatchObject({
    code: "usage",
    message: "POD_DB_URL is not set",
  });
});

test("config id fails a bad file as config apply does", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-config-id-bad-"));
  const invalidYaml = join(dir, "invalid.yaml");
  writeFileSync(invalidYaml, "kind: [process\n");
  const noKind = join(dir, "no-kind.yaml");
  writeFileSync(noKind, processSeed.replace("kind: process\n", ""));
  const env = noDatabase();
  for (const path of [join(dir, "missing.yaml"), invalidYaml, noKind]) {
    const id = run(["config", "id", path], env);
    const apply = run(["config", "apply", path], env);
    expect(id.status, path).toBe(2);
    expect(id.status, path).toBe(apply.status);
    expect(id.stdout, path).toBe(apply.stdout);
  }
});
