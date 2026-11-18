import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import {
  groomRefusal,
  groomStages,
  parseGroom,
  type GroomValue,
} from "../../src/core/config/groom.ts";
import type { RevisionEnvelope } from "../../src/core/domain/config.ts";

const seedPath = "specs/groom/default.yaml";
const seed = parse(readFileSync(seedPath, "utf8")) as RevisionEnvelope;
const value = seed.value as GroomValue;

function refusedAt(change: Partial<RevisionEnvelope>) {
  const refusal = groomRefusal({ ...seed, ...change });
  return refusal === null ? null : [refusal.code, refusal.nextSteps[0]];
}

function refusedValue(edit: (copy: Record<string, unknown>) => void) {
  const copy = structuredClone(value) as unknown as Record<string, unknown>;
  edit(copy);
  return refusedAt({ value: copy as RevisionEnvelope["value"] });
}

function drop(map: unknown, key: string): void {
  delete (map as Record<string, unknown>)[key];
}

test("the seed is a global groom Revision named default that passes its schema", () => {
  expect(seed).toMatchObject({
    kind: "groom",
    name: "default",
    scope: "global",
    scope_ref: "",
  });
  expect(groomRefusal(seed)).toBeNull();
});

test("the seed rubric has three stages, each with a meaning for every point", () => {
  const groom = parseGroom(seed.value);
  expect(Object.keys(groom.rubric).sort()).toEqual([...groomStages].sort());
  for (const stage of groomStages)
    for (const point of groom.scale)
      expect(groom.rubric[stage][String(point)]).toMatch(/\S/);
});

test("every point maps to a size and a tier, and split_at is 8 with children at most 3", () => {
  const groom = parseGroom(seed.value);
  expect(groom.scale).toEqual([1, 2, 3, 5, 8]);
  expect(groom.points_to_size).toEqual({
    "1": "xs",
    "2": "s",
    "3": "m",
    "5": "l",
    "8": "xl",
  });
  expect(Object.keys(groom.tiers).sort()).toEqual(["1", "2", "3", "5", "8"]);
  expect(groom.tiers["5"]).toBe("never_launched");
  expect(groom.tiers["8"]).toBe("never_launched");
  expect(groom.split_at).toBe(8);
  expect(groom.child_max).toBe(3);
  expect(groom.proves.under.length).toBeGreaterThan(0);
  expect(groom.default_points.every((row) => row.points < 8)).toBe(true);
});

test("a missing stage, point, size, or tier is schema_invalid naming its path", () => {
  expect(refusedValue((v) => drop(v["rubric"], "prd"))).toEqual([
    "schema_invalid",
    "rubric.prd",
  ]);
  expect(
    refusedValue((v) => drop((v["rubric"] as GroomValue["rubric"]).impl, "5")),
  ).toEqual(["schema_invalid", "rubric.impl.5"]);
  expect(refusedValue((v) => drop(v["points_to_size"], "8"))).toEqual([
    "schema_invalid",
    "points_to_size.8",
  ]);
  expect(refusedValue((v) => drop(v["tiers"], "3"))).toEqual([
    "schema_invalid",
    "tiers.3",
  ]);
  expect(
    refusedValue((v) => {
      (v["points_to_size"] as Record<string, string>)["2"] = "huge";
    }),
  ).toEqual(["schema_invalid", "points_to_size.2"]);
});

test("a point off the scale, an extra stage, or a bad split is schema_invalid naming its path", () => {
  expect(
    refusedValue((v) => {
      (v["tiers"] as Record<string, string>)["4"] = "lean";
    }),
  ).toEqual(["schema_invalid", "tiers.4"]);
  expect(
    refusedValue((v) => {
      (v["rubric"] as Record<string, unknown>)["deploy"] = {};
    }),
  ).toEqual(["schema_invalid", "rubric.deploy"]);
  expect(refusedValue((v) => (v["scale"] = [1, 3, 2, 5, 8]))).toEqual([
    "schema_invalid",
    "scale.2",
  ]);
  expect(refusedValue((v) => (v["split_at"] = 13))).toEqual([
    "schema_invalid",
    "split_at",
  ]);
  expect(refusedValue((v) => (v["child_max"] = 8))).toEqual([
    "schema_invalid",
    "child_max",
  ]);
});

test("default_points ascend below split_at, and proves.under holds relative directories", () => {
  const rows = value.default_points;
  expect(
    refusedValue((v) => (v["default_points"] = [rows[1], rows[0]])),
  ).toEqual(["schema_invalid", "default_points.1"]);
  expect(
    refusedValue(
      (v) =>
        (v["default_points"] = [{ points: 8, max_paths: 1, max_callers: 1 }]),
    ),
  ).toEqual(["schema_invalid", "default_points.0.points"]);
  expect(refusedValue((v) => (v["proves"] = { under: ["/etc"] }))).toEqual([
    "schema_invalid",
    "proves.under.0",
  ]);
  expect(refusedValue((v) => (v["proves"] = { under: ["src/../x"] }))).toEqual([
    "schema_invalid",
    "proves.under.0",
  ]);
  expect(
    refusedValue((v) => (v["proves"] = { under: ["src", "src"] })),
  ).toEqual(["schema_invalid", "proves.under.1"]);
});

test("another scope or name is schema_invalid naming the field", () => {
  expect(refusedAt({ name: "fast" })).toEqual(["schema_invalid", "name"]);
  expect(refusedAt({ scope: "project", scope_ref: "p" })).toEqual([
    "schema_invalid",
    "scope",
  ]);
});

test("the seed names no adopter", () => {
  expect(readFileSync(seedPath, "utf8")).not.toMatch(
    /jerry|tpcw|lance|argus|jako|ellie|linear/i,
  );
});
