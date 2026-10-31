import { expect, test } from "vitest";
import {
  makeTrackerScrubber,
  parseReplacements,
  ReplacementListInvalid,
} from "../../src/adapters/linear/scrub.ts";

function scrubber(denylist: string[] = []) {
  return makeTrackerScrubber({
    hosts: ["box-1"],
    users: ["alice"],
    roots: [],
    workspace: ["acme"],
    denylist,
  });
}

test("issue identifiers map in first-seen order and their team key becomes trk", () => {
  const scrub = scrubber();
  expect(scrub.scrub("ABC-17 then ABC-4 then ABC-17")).toBe(
    "TRK-1 then TRK-2 then TRK-1",
  );
  expect(scrub.scrub("team ABC and ABC-4")).toBe("team trk and TRK-2");
});

test("the workspace key becomes trk as a word, case-insensitively", () => {
  expect(scrubber().scrub("acme-dev/pod and ACME")).toBe("trk-dev/pod and trk");
});

test("UUIDs map to stable placeholders across texts", () => {
  const scrub = scrubber();
  const id = "3fa53317-0702-48cb-b38f-fa879369a457";
  expect(scrub.scrub(`{"id":"${id}"}`)).toBe(
    '{"id":"00000000-0000-4000-8000-000000000001"}',
  );
  expect(scrub.scrub(id.toUpperCase())).toBe(
    "00000000-0000-4000-8000-000000000001",
  );
  expect(scrub.scrub("d4638974-9d3b-44de-95ba-310e21dfc490")).toBe(
    "00000000-0000-4000-8000-000000000002",
  );
});

test("hosts, users, and the denylist apply as they do for Orca", () => {
  const scrub = scrubber(["secretco"]);
  expect(scrub.scrub("alice on box-1")).toBe("user-1 on host-a");
  expect(scrub.hits("built by SecretCo")).toEqual(["secretco"]);
});

test("a listed replacement is gone before the denylist check", () => {
  const scrub = makeTrackerScrubber({
    hosts: [],
    users: [],
    roots: [],
    workspace: [],
    denylist: ["secretco", "otherco"],
    replacements: [{ term: "secretco", replacement: "keeper" }],
  });
  const text = scrub.scrub("SecretCo keeps the gate, and OtherCo does not");
  expect(text).toBe("keeper keeps the gate, and OtherCo does not");
  expect(scrub.hits(text)).toEqual(["otherco"]);
});

test("POD_SCRUB_REPLACEMENTS pairs parse term=replacement", () => {
  expect(parseReplacements("")).toEqual([]);
  expect(parseReplacements(" secretco = keeper , otherco=operator ")).toEqual([
    { term: "secretco", replacement: "keeper" },
    { term: "otherco", replacement: "operator" },
  ]);
  expect(() => parseReplacements("secretco")).toThrow(ReplacementListInvalid);
  expect(() => parseReplacements("=keeper")).toThrow(ReplacementListInvalid);
  expect(() => parseReplacements("secretco=")).toThrow(ReplacementListInvalid);
});
