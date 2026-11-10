import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PodError } from "../src/cli/errors.ts";
import { readHostProfile } from "../src/cli/host-profile.ts";
import {
  actorOf,
  mayActivate,
  resolveIdentity,
  seatFromEnv,
} from "../src/cli/identity.ts";

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
  operator: null,
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
    operator: null,
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
