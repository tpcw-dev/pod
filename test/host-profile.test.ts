import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PodError } from "../src/cli/errors.ts";
import {
  databaseUrl,
  readCredentials,
  readHostProfile,
} from "../src/cli/host-profile.ts";
import {
  actorOf,
  mayActivate,
  resolveIdentity,
  seatFromEnv,
} from "../src/cli/identity.ts";

const saved = process.env["POD_HOME"];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env["POD_HOME"];
  else process.env["POD_HOME"] = saved;
});

function home(profile: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "pod-host-"));
  if (profile !== null) writeFileSync(join(dir, "host.yaml"), profile);
  process.env["POD_HOME"] = dir;
}

const defaults = () => ({
  credentialsFile: join(process.env["POD_HOME"] ?? "", "credentials"),
  capacity: 2,
  trackerKind: "linear",
  trackerTokenEnv: "POD_TRACKER_TOKEN",
  estimateScale: "fibonacci",
  docsKind: "notion",
  docsTokenEnv: "POD_DOCS_TOKEN",
  operator: null,
});

test("no profile reads the defaults", () => {
  home(null);
  expect(readHostProfile()).toEqual({
    ...defaults(),
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
});

test("a profile without db keeps the default variable", () => {
  home("{}\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
  home("host_id: h\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
    hostId: "h",
    urlEnv: "POD_DB_URL",
  });
});

test("db.url_env names the variable", () => {
  home("db:\n  url_env: X\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
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
    credentialsFile: join(process.env["POD_HOME"] ?? "", "credentials"),
    capacity: 1,
    trackerKind: "other",
    trackerTokenEnv: "POD_TRACKER_TOKEN",
    estimateScale: "fibonacci",
    docsKind: "notion",
    docsTokenEnv: "POD_DOCS_TOKEN",
    operator: null,
  });
});

test("tracker.token_env and tracker.estimate_scale are read when set", () => {
  home("tracker:\n  token_env: T\n  estimate_scale: tshirt\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
    hostId: "local",
    urlEnv: "POD_DB_URL",
    trackerTokenEnv: "T",
    estimateScale: "tshirt",
  });
});

test("a docs block without fields keeps the docs defaults", () => {
  home("docs: {}\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
    hostId: "local",
    urlEnv: "POD_DB_URL",
  });
});

test("docs.kind and docs.token_env are read when set", () => {
  home("docs:\n  kind: other\n  token_env: D\n");
  expect(readHostProfile()).toEqual({
    ...defaults(),
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

test("operator: names the principal who runs this shell", () => {
  home("operator: alex\n");
  expect(readHostProfile().operator).toBe("alex");
});

test("an empty operator: is schema_invalid", () => {
  home("operator: ''\n");
  expect(() => readHostProfile()).toThrow(PodError);
});

const noFacts = {
  podSeat: null,
  recordedSeat: null,
  unresolved: [],
  operator: null,
};

function refusal(run: () => unknown): { code: string; next: string[] } {
  try {
    run();
  } catch (error) {
    if (error instanceof PodError)
      return { code: error.code, next: [...error.nextSteps] };
    throw error;
  }
  throw new Error("expected a refusal");
}

test("POD_SEAT is read from the environment, and empty reads as unset", () => {
  expect(seatFromEnv({ POD_SEAT: "developer" })).toBe("developer");
  expect(seatFromEnv({ POD_SEAT: "" })).toBeNull();
  expect(seatFromEnv({})).toBeNull();
});

test("POD_SEAT wins over the host operator", () => {
  const identity = resolveIdentity({
    ...noFacts,
    podSeat: "developer",
    operator: "alex",
  });
  expect(actorOf(identity)).toBe("seat:developer");
});

test("a terminal the ledger records is a Seat, not the operator", () => {
  const identity = resolveIdentity({
    ...noFacts,
    recordedSeat: "reviewer",
    operator: "alex",
  });
  expect(actorOf(identity)).toBe("seat:reviewer");
});

test("the host operator is a person", () => {
  expect(actorOf(resolveIdentity({ ...noFacts, operator: "alex" }))).toBe(
    "person:alex",
  );
});

test("neither POD_SEAT nor operator: is identity_missing", () => {
  const refused = refusal(() => resolveIdentity(noFacts));
  expect(refused.code).toBe("identity_missing");
  expect(refused.next.join(" ")).toContain("operator:");
  expect(refused.next.join(" ")).toContain("POD_SEAT");
});

test("a worker the run cannot be told apart from is identity_missing, not the operator", () => {
  const refused = refusal(() =>
    resolveIdentity({ ...noFacts, unresolved: ["d-1"], operator: "alex" }),
  );
  expect(refused.code).toBe("identity_missing");
  expect(refused.next.join(" ")).toContain("d-1");
});

test("a Seat may write but not activate", () => {
  const seat = resolveIdentity({ ...noFacts, podSeat: "developer" });
  expect(() => mayActivate(seat, false)).not.toThrow();
  expect(refusal(() => mayActivate(seat, true)).code).toBe(
    "activation_needs_person",
  );
  const person = resolveIdentity({ ...noFacts, operator: "alex" });
  expect(() => mayActivate(person, true)).not.toThrow();
});

const fileUrl = "scheme://user:example-not-a-secret@db.invalid/pod";
const envUrl = "scheme://user:example-env-value@db.invalid/pod";

function cleanEnv(): void {
  for (const name of ["POD_DB_URL", "POD_TRACKER_TOKEN", "POD_DOCS_TOKEN"])
    vi.stubEnv(name, "");
}

function credentials(text: string, mode = 0o600): string {
  const path = join(process.env["POD_HOME"] ?? "", "credentials");
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

function podError(read: () => unknown): PodError {
  try {
    read();
  } catch (error) {
    if (error instanceof PodError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

test("credentials_file is read from the profile, a relative one under POD_HOME", () => {
  home("credentials_file: /elsewhere/creds\n");
  expect(readHostProfile().credentialsFile).toBe("/elsewhere/creds");
  home("credentials_file: sub/creds\n");
  expect(readHostProfile().credentialsFile).toBe(
    join(process.env["POD_HOME"] ?? "", "sub", "creds"),
  );
});

test("the credentials file is the only source when it exists", () => {
  home(null);
  cleanEnv();
  vi.stubEnv("POD_DB_URL", envUrl);
  vi.stubEnv("POD_TRACKER_TOKEN", "example-env-token");
  credentials(
    `# pod credentials\n\nPOD_DB_URL=${fileUrl}\r\nPOD_DOCS_TOKEN = example-docs-token \n`,
  );
  const host = readHostProfile();
  const read = readCredentials(host);
  expect(read.source).toBe("file");
  expect(databaseUrl(host)).toBe(fileUrl);
  expect(read.get("POD_DOCS_TOKEN")).toBe("example-docs-token");
  expect(read.get("POD_TRACKER_TOKEN")).toBeNull();
  expect(read.values().sort()).toEqual([fileUrl, "example-docs-token"].sort());
});

test("a value keeps every = after the first", () => {
  home(null);
  cleanEnv();
  credentials("POD_DOCS_TOKEN=a=b=\n");
  expect(readCredentials(readHostProfile()).get("POD_DOCS_TOKEN")).toBe("a=b=");
});

test("a credentials file of mode 0644 is refused with chmod 600", () => {
  home(null);
  cleanEnv();
  const path = credentials(`POD_DB_URL=${fileUrl}\n`, 0o644);
  const error = podError(() => databaseUrl(readHostProfile()));
  expect(error).toMatchObject({
    code: "usage",
    nextSteps: [`chmod 600 ${path}`],
  });
  expect(JSON.stringify(error)).not.toContain("example-not-a-secret");
  expect(error.message).not.toContain("example-not-a-secret");
});

test("an owner-unreadable credentials file is refused with chmod 600", () => {
  home(null);
  cleanEnv();
  const path = credentials("POD_DB_URL=x\n", 0o000);
  expect(podError(() => readCredentials(readHostProfile()))).toMatchObject({
    code: "usage",
    message: `${path} cannot be read`,
    nextSteps: [`chmod 600 ${path}`],
  });
});

test("a malformed line is refused by its number, not its text", () => {
  home(null);
  cleanEnv();
  credentials("POD_DB_URL=x\nexample-not-a-secret\n");
  const error = podError(() => readCredentials(readHostProfile()));
  expect(error.code).toBe("usage");
  expect(error.message).toContain("line 2");
  expect(error.message).not.toContain("example-not-a-secret");
  expect(error.nextSteps.join(" ")).not.toContain("example-not-a-secret");
});

test("a directory at the credentials path is refused", () => {
  home(null);
  cleanEnv();
  mkdirSync(join(process.env["POD_HOME"] ?? "", "credentials"), {
    mode: 0o700,
  });
  expect(podError(() => readCredentials(readHostProfile())).code).toBe("usage");
});

test("a name the credentials file lacks names the file", () => {
  home(null);
  cleanEnv();
  vi.stubEnv("POD_DB_URL", envUrl);
  const path = credentials("POD_DOCS_TOKEN=example-docs-token\n");
  const error = podError(() => databaseUrl(readHostProfile()));
  expect(error).toMatchObject({
    code: "usage",
    message: `POD_DB_URL is not set in ${path}`,
  });
  expect(error.nextSteps).toEqual([
    `add POD_DB_URL=<the database URL> to ${path}`,
  ]);
});

test("an absent credentials file falls back to the environment, with a warning", () => {
  home(null);
  cleanEnv();
  vi.stubEnv("POD_DB_URL", envUrl);
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const host = readHostProfile();
  expect(databaseUrl(host)).toBe(envUrl);
  expect(databaseUrl(host)).toBe(envUrl);
  const read = readCredentials(host);
  expect(read.source).toBe("env");
  expect(read.values()).toEqual([envUrl]);
  expect(read.warnings()).toEqual([]);
  expect(writes).toEqual([
    `warning: ${host.credentialsFile} is absent; POD_DB_URL is read from the session environment, which Seats inherit\n`,
  ]);
  expect(writes.join("")).not.toContain("example-env-value");
});

test("an exported credential name is a warning when the credentials file exists", () => {
  home(null);
  cleanEnv();
  vi.stubEnv("POD_DB_URL", envUrl);
  vi.stubEnv("POD_DOCS_TOKEN", "");
  credentials(`POD_DB_URL=${fileUrl}\n`);
  expect(readCredentials(readHostProfile()).warnings()).toEqual([
    "POD_DB_URL is exported in this session; Seats inherit it. Remove it from the session environment",
  ]);
});
