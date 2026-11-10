import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

function section(): string[] {
  const lines = readFileSync("docs/tech-spec.md", "utf8").split("\n");
  const start = lines.indexOf("### Operator pages and profiles");
  const end = lines.indexOf("### Later milestones this spec keeps room for");
  expect(start).toBeGreaterThan(lines.indexOf("### Story order and what each adds"));
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end);
}

test("the spec has the operator pages and profiles section", () => {
  expect(section()[0]).toBe("### Operator pages and profiles");
});

test("the profile table has one row per profile", () => {
  const rows = section()
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(" | ")[0]?.slice(2))
    .filter((cell) => /^`(hands-on|standard|hands-off|autonomous)`$/.test(cell ?? ""));
  expect(rows).toEqual(["`hands-on`", "`standard`", "`hands-off`", "`autonomous`"]);
});

test("the section states the conditions that keep autonomous refused", () => {
  expect(section()).toContain(
    "`autonomous` stays refused with `gate_lift_refused` until groom, plan, the operate loop, the gate set with its needs-human exit, and policy `attention` all land. Lifting the refusal is a separate ticket that a person decides.",
  );
});
