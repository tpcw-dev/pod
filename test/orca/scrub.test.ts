import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  FixtureRefused,
  makeScrubber,
  writeFixture,
} from "../../src/adapters/orca/scrub.ts";
import { makeTrackerScrubber } from "../../src/adapters/linear/scrub.ts";
import { makeDocsScrubber } from "../../src/adapters/notion/scrub.ts";
import { hasUserinfoPassword } from "../../src/core/domain/scrub.ts";
import type { ReceiptRecord } from "../../src/core/ports/orca.ts";

function record(stdout: string): ReceiptRecord {
  return {
    verb: "worker-start",
    argv: ["orchestration", "worker-start", "--json"],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    startedAt: "2026-10-26T00:00:00.000Z",
    endedAt: "2026-10-26T00:00:01.000Z",
    orcaVersion: "1.4.211",
  };
}

test("hosts, worktree paths, and user names are replaced in order", () => {
  const scrubber = makeScrubber({
    hosts: ["builder-one", "Builder-Two"],
    users: ["alice"],
    roots: [],
    denylist: [],
  });
  const text = JSON.stringify({
    host: "builder-one",
    other: "builder-two",
    again: "BUILDER-ONE",
    first: "/home/alice/work/repo-a",
    second: "/Users/alice/work/repo-b/src",
    firstAgain: "/home/alice/work/repo-a",
    user: "alice",
  });
  expect(JSON.parse(scrubber.scrub(text))).toEqual({
    host: "host-a",
    other: "host-b",
    again: "host-a",
    first: "/w/1",
    second: "/w/2",
    firstAgain: "/w/1",
    user: "user-1",
  });
});

test("a worktree root outside a home directory becomes /w/<n> with its subpath", () => {
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: ["/srv/wt/pod"],
    denylist: [],
  });
  expect(scrubber.scrub("cwd /srv/wt/pod/src and /srv/wt/pod")).toBe(
    "cwd /w/1/src and /w/1",
  );
});

test("a backslash-n before a term is still a whole word", () => {
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: [],
    denylist: ["secretco"],
    replacements: [{ term: "secretco", replacement: "keeper" }],
  });
  const text = String.raw`{"note":"head\nsecretco: PASS"}`;
  expect(scrubber.hits(text)).toEqual(["secretco"]);
  expect(scrubber.scrub(text)).toBe(String.raw`{"note":"head\nkeeper: PASS"}`);
  expect(scrubber.hits(scrubber.scrub(text))).toEqual([]);
  expect(scrubber.hits(String.raw`\nsecretcoextra`)).toEqual([]);
});

test("a listed replacement is gone before the denylist check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-scrub-"));
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: [],
    denylist: ["secretco", "otherco"],
    replacements: [{ term: "secretco", replacement: "keeper" }],
  });
  const text = scrubber.scrub("SecretCo keeps the gate, and OtherCo does not");
  expect(text).toBe("keeper keeps the gate, and OtherCo does not");
  expect(scrubber.hits(text)).toEqual(["otherco"]);
  expect(writeFixture(dir, record('{"note":"SecretCo"}'), [], scrubber)).toBe(
    "001-worker-start.json",
  );
});

test("a denylist hit refuses the write and leaves no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-scrub-"));
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: [],
    denylist: ["", "  ", "secretco"],
  });
  expect(() =>
    writeFixture(dir, record('{"note":"SecretCo build"}'), [], scrubber),
  ).toThrow(FixtureRefused);
  expect(readdirSync(dir)).toEqual([]);
  expect(writeFixture(dir, record('{"note":"secretcode"}'), [], scrubber)).toBe(
    "001-worker-start.json",
  );
  const written = JSON.parse(
    readFileSync(join(dir, "001-worker-start.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(written).toMatchObject({
    verb: "worker-start",
    match: { argv: [] },
    recordedAt: "2026-10-26T00:00:01.000Z",
  });
});

test("a terminal-show fixture keeps no title, branch, or preview text", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-scrub-"));
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: [],
    denylist: [],
  });
  const stdout = JSON.stringify({
    ok: true,
    result: {
      terminal: {
        handle: "term_1",
        title: "me@box:~/work/TPC-9",
        branch: "refs/heads/me/tpc-9",
        preview: "$ bash .tmp/run.sh",
        connected: false,
        exitCause: { kind: "operator_close" },
      },
    },
  });
  const name = writeFixture(
    dir,
    { ...record(stdout), verb: "terminal-show" },
    [],
    scrubber,
  );
  const written = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    stdout: string;
  };
  expect(JSON.parse(written.stdout)).toEqual({
    ok: true,
    result: {
      terminal: {
        handle: "term_1",
        title: "",
        branch: "",
        preview: "",
        connected: false,
        exitCause: { kind: "operator_close" },
      },
    },
  });
  expect(writeFixture(dir, record(stdout), [], scrubber)).toBe(
    "002-worker-start.json",
  );
  const other = JSON.parse(
    readFileSync(join(dir, "002-worker-start.json"), "utf8"),
  ) as { stdout: string };
  expect(other.stdout).toBe(stdout);
});

const none = { hosts: [], users: [], roots: [], denylist: [] };

test("a value equal to a credential this process read becomes [credential]", () => {
  const scrubber = makeScrubber({
    ...none,
    credentials: ["example-not-a-secret", "example-not-a-secret-longer"],
  });
  expect(
    scrubber.scrub(
      '{"token":"example-not-a-secret-longer","auth":"Bearer example-not-a-secret"}',
    ),
  ).toBe('{"token":"[credential]","auth":"Bearer [credential]"}');
});

test("a URL userinfo password becomes [credential] with no credential list", () => {
  const scrubber = makeScrubber(none);
  expect(
    scrubber.scrub("url scheme://user:example-not-a-secret@db.invalid/pod"),
  ).toBe("url scheme://user:[credential]@db.invalid/pod");
  expect(scrubber.scrub("https://db.invalid:5432/pod")).toBe(
    "https://db.invalid:5432/pod",
  );
});

test("a credential holding a tracker or docs id becomes [credential] whole", () => {
  const uuid = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const tracker = makeTrackerScrubber({
    ...none,
    workspace: [],
    teamKeys: [],
    credentials: [`example-${uuid}`],
  });
  expect(tracker.scrub(`token example-${uuid} and ${uuid}`)).toBe(
    "token [credential] and 00000000-0000-4000-8000-000000000001",
  );
  const hex = "0f1e2d3c4b5a49688776655443322110";
  const docs = makeDocsScrubber({
    ...none,
    workspace: [],
    credentials: [`example_${hex}`],
  });
  expect(docs.scrub(`token example_${hex}`)).toBe("token [credential]");
});

test("hasUserinfoPassword finds a password but not a redacted one", () => {
  expect(
    hasUserinfoPassword("scheme://user:example-not-a-secret@db.invalid/pod"),
  ).toBe(true);
  expect(hasUserinfoPassword("scheme://user:[credential]@db.invalid/pod")).toBe(
    false,
  );
  expect(hasUserinfoPassword("scheme://user@db.invalid/pod")).toBe(false);
  expect(hasUserinfoPassword("https://db.invalid:5432/pod")).toBe(false);
});
