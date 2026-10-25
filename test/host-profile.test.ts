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

test("no profile reads the defaults", () => {
  home(null);
  expect(readHostProfile()).toEqual({ hostId: "local", urlEnv: "POD_DB_URL" });
});

test("a profile without db keeps the default variable", () => {
  home("{}\n");
  expect(readHostProfile()).toEqual({ hostId: "local", urlEnv: "POD_DB_URL" });
  home("host_id: h\n");
  expect(readHostProfile()).toEqual({ hostId: "h", urlEnv: "POD_DB_URL" });
});

test("db.url_env names the variable", () => {
  home("db:\n  url_env: X\n");
  expect(readHostProfile()).toEqual({ hostId: "local", urlEnv: "X" });
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
