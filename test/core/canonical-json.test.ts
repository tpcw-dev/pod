import { expect, test } from "vitest";
import {
  canonicalJson,
  revisionId,
  snapshotHash,
} from "../../src/core/config/canonical-json.ts";

test("keys sort and whitespace drops", () => {
  expect(canonicalJson({ b: 1, a: [3, { d: true, c: null }] })).toBe(
    '{"a":[3,{"c":null,"d":true}],"b":1}',
  );
});

test("keys sort by UTF-16 code units", () => {
  expect(canonicalJson({ "\u{1F600}": 1, z: 2, é: 3, "￿": 4 })).toBe(
    '{"z":2,"é":3,"\u{1F600}":1,"￿":4}',
  );
});

test("unicode passes through and strings escape as JSON.stringify does", () => {
  expect(canonicalJson(["日本", 'a"b\n'])).toBe('["日本","a\\"b\\n"]');
});

test("numbers write as JSON.stringify writes them", () => {
  expect(canonicalJson([-0, 1.5, 1e21, 0.1])).toBe("[0,1.5,1e+21,0.1]");
});

test("values JSON cannot carry throw", () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    { a: undefined },
    [undefined],
    [1, , 2],
    new Date(0),
    new Map(),
    10n,
    () => 1,
  ]) {
    expect(() => canonicalJson(value), String(value)).toThrow(TypeError);
  }
});

test("an object with a null prototype is plain", () => {
  const value = Object.assign(Object.create(null) as object, { b: 1, a: 2 });
  expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
});

const envelope = {
  kind: "process",
  name: "impl-small",
  schema_version: 1,
  scope: "global",
  scope_ref: "",
  parent: null,
  value: { steps: [{ id: "build", role: "developer" }] },
} as const;

test("a committed envelope has a pinned id", () => {
  expect(revisionId(envelope)).toBe(
    "935c0d64fb593f189741d3654b7502f4e22f520168982b77c533d8b5883d4968",
  );
});

test("an absent parent hashes as null", () => {
  const { parent, ...rest } = envelope;
  expect(parent).toBeNull();
  expect(revisionId(rest)).toBe(revisionId(envelope));
});

test("scope_ref is in the hash", () => {
  expect(
    revisionId({ ...envelope, scope: "project", scope_ref: "p1" }),
  ).not.toBe(revisionId({ ...envelope, scope: "project", scope_ref: "p2" }));
});

test("the snapshot hash covers the ids and the gate map", () => {
  const ids = { crew: "c", process: "p", policy: "q" };
  const first = snapshotHash(ids, { review: "crew" });
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(snapshotHash(ids, { review: "crew" })).toBe(first);
  expect(snapshotHash(ids, { review: "person" })).not.toBe(first);
  expect(snapshotHash({ ...ids, crew: "d" }, { review: "crew" })).not.toBe(
    first,
  );
});
