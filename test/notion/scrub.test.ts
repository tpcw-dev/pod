import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeDocsFixture } from "../../src/adapters/notion/fixture.ts";
import {
  makeDocsScrubber,
  trimUsers,
} from "../../src/adapters/notion/scrub.ts";
import type { DocsReceiptRecord } from "../../src/core/ports/docs.ts";

function scrubber(denylist: string[] = []) {
  return makeDocsScrubber({
    hosts: ["box-1"],
    users: ["alice"],
    roots: [],
    workspace: ["Acme Space"],
    denylist,
  });
}

const page = "40a4191e929a81d991b6f0f107886df6";
const pageHyphens = "40a4191e-929a-81d9-91b6-f0f107886df6";
const table = "3fb728e7-f1ff-4432-83cd-08398131ae7e";

test("ids map to placeholders in first-seen order", () => {
  const scrub = scrubber();
  expect(scrub.scrub(`${table} then ${page} then ${table}`)).toBe(
    "00000000-0000-4000-8000-000000000001 then 00000000-0000-4000-8000-000000000002 then 00000000-0000-4000-8000-000000000001",
  );
});

test("the hyphen and no-hyphen forms of one id map to one placeholder", () => {
  const scrub = scrubber();
  expect(scrub.scrub(`/v1/blocks/${page}/children`)).toBe(
    "/v1/blocks/00000000-0000-4000-8000-000000000001/children",
  );
  expect(scrub.scrub(`{"page_id":"${pageHyphens.toUpperCase()}"}`)).toBe(
    '{"page_id":"00000000-0000-4000-8000-000000000001"}',
  );
});

test("a longer hex run is not an id", () => {
  const sha = "a".repeat(64);
  expect(scrubber().scrub(sha)).toBe(sha);
});

test("the workspace name becomes docs as a word, case-insensitively", () => {
  expect(scrubber().scrub("in acme space and ACME SPACE")).toBe(
    "in docs and docs",
  );
});

test("hosts, users, and the denylist apply as they do for the tracker", () => {
  const scrub = scrubber(["secretco"]);
  expect(scrub.scrub("alice on box-1")).toBe("user-1 on host-a");
  expect(scrub.hits("built by SecretCo")).toEqual(["secretco"]);
});

test("created_by and last_edited_by keep only object and id", () => {
  const body = JSON.stringify({
    results: [
      {
        id: table,
        created_by: { object: "user", id: "u-1", name: "Someone" },
        last_edited_by: { object: "user", id: "u-2", avatar_url: "x" },
      },
    ],
  });
  expect(JSON.parse(trimUsers(body))).toEqual({
    results: [
      {
        id: table,
        created_by: { object: "user", id: "u-1" },
        last_edited_by: { object: "user", id: "u-2" },
      },
    ],
  });
  expect(trimUsers("not json")).toBe("not json");
});

function record(
  path: string,
  body: unknown,
  query: Record<string, string> = { page_size: "100" },
): DocsReceiptRecord {
  return {
    verb: "readSection",
    port: "docs",
    page,
    heading: "Milestones",
    request: { method: "GET", path, query },
    status: 200,
    body: JSON.stringify(body),
    error: null,
    requestId: "r-1",
    startedAt: "2026-10-31T00:00:00.000Z",
    endedAt: "2026-10-31T00:00:01.000Z",
  };
}

test("one scrubber keeps an id from one fixture's body in the next fixture's path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-docs-"));
  const scrub = scrubber();
  const first = writeDocsFixture(
    dir,
    record(`/v1/blocks/${page}/children`, {
      results: [{ id: table, type: "table", parent: { page_id: pageHyphens } }],
    }),
    scrub,
  );
  const second = writeDocsFixture(
    dir,
    record(`/v1/blocks/${table.replaceAll("-", "")}/children`, {
      results: [],
    }),
    scrub,
  );
  expect([first, second]).toEqual([
    "001-readSection.json",
    "002-readSection.json",
  ]);
  const one = JSON.parse(readFileSync(join(dir, first), "utf8"));
  const two = JSON.parse(readFileSync(join(dir, second), "utf8"));
  expect(one.page).toBe("00000000-0000-4000-8000-000000000001");
  expect(JSON.parse(one.body).results[0].id).toBe(
    "00000000-0000-4000-8000-000000000002",
  );
  expect(two.match).toEqual({
    method: "GET",
    path: "/v1/blocks/00000000-0000-4000-8000-000000000002/children",
    query: { page_size: "100" },
  });
});

test("a fixture that still hits the denylist is refused and not written", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-docs-"));
  expect(() =>
    writeDocsFixture(
      dir,
      record(`/v1/blocks/${page}/children`, { results: [], note: "secretco" }),
      scrubber(["secretco"]),
    ),
  ).toThrow(/denylist/);
});
