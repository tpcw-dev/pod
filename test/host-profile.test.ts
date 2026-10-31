import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PodError } from "../src/cli/errors.ts";
import { readHostProfile } from "../src/cli/host-profile.ts";

const saved = process.env["POD_HOME"];
afterEach(() => {
  if (saved === undefined) delete process.env["POD_HOME"];
  else process.env["POD_HOME"] = saved;
});

function home(profile: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "pod-host-"));
  if (profile !== null) writeFileSync(join(dir, "host.yaml"), profile);
  process.env["POD_HOME"] = dir;
}

const defaults = {
  capacity: 2,
  trackerKind: "linear",
  trackerTokenEnv: "POD_TRACKER_TOKEN",
  estimateScale: "fibonacci",
  docsKind: "notion",
  docsTokenEnv: "POD_DOCS_TOKEN",
};

test("no profile reads the defaults", () => {
  home(null);
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
});

test("a profile without db keeps the default variable", () => {
  home("{}\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
  home("host_id: h\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "h",
    urlEnv: "POD_DB_URL",
  });
});

test("db.url_env names the variable", () => {
  home("db:\n  url_env: X\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "X",
  });
});

test("an empty db.url_env is schema_invalid", () => {
  home('db:\n  url_env: ""\n');
  let caught: unknown;
  try {
    readHostProfile();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PodError);
  expect(caught).toMatchObject({
    code: "schema_invalid",
    exit: 2,
    nextSteps: [expect.stringMatching(/^db\.url_env: /)],
  });
});

test("capacity and tracker.kind are read when set", () => {
  home("capacity: 1\ntracker:\n  kind: other\n");
  expect(readHostProfile()).toEqual({
    hostId: "local",
    urlEnv: "POD_DB_URL",
    capacity: 1,
    trackerKind: "other",
    trackerTokenEnv: "POD_TRACKER_TOKEN",
    estimateScale: "fibonacci",
    docsKind: "notion",
    docsTokenEnv: "POD_DOCS_TOKEN",
  });
});

test("tracker.token_env and tracker.estimate_scale are read when set", () => {
  home("tracker:\n  token_env: T\n  estimate_scale: tshirt\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "POD_DB_URL",
    trackerTokenEnv: "T",
    estimateScale: "tshirt",
  });
});

test("a docs block without fields keeps the docs defaults", () => {
  home("docs: {}\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
});

test("docs.kind and docs.token_env are read when set", () => {
  home("docs:\n  kind: other\n  token_env: D\n");
  expect(readHostProfile()).toEqual({
    ...defaults,
    hostId: "local",
    urlEnv: "POD_DB_URL",
    docsKind: "other",
    docsTokenEnv: "D",
  });
});

test("a capacity below 1 is schema_invalid", () => {
  home("capacity: 0\n");
  expect(() => readHostProfile()).toThrow(PodError);
});
