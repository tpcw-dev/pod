import { expect, test } from "vitest";
import {
  selectProcess,
  type ActiveProcess,
  type ProcessRef,
} from "../../src/core/process/select.ts";
import type { Size } from "../../src/core/process/schema.ts";

const small: ActiveProcess = {
  revisionId: "rev-small",
  name: "impl-small",
  rev: 1,
  selector: { stage: "impl", size: ["xs", "s"] },
};
const medium: ActiveProcess = {
  revisionId: "rev-medium",
  name: "impl-medium",
  rev: 1,
  selector: { stage: "impl", size: ["m"] },
};
const twin: ActiveProcess = {
  revisionId: "rev-twin",
  name: "impl-twin",
  rev: 1,
  selector: { stage: "impl", size: ["xs", "s"] },
};

function ref(name: string | null): ProcessRef | null {
  return name === null ? null : { name, rev: 1 };
}

function select(
  stage: string,
  size: Size,
  kickoff: string | null,
  cli: string | null,
  activations: readonly ActiveProcess[],
  named: ActiveProcess | null = null,
): string {
  const outcome = selectProcess({
    stage,
    size,
    kickoffLine: ref(kickoff),
    cliProcess: ref(cli),
    activations,
    named,
  });
  return outcome.ok ? outcome.revisionId : outcome.code;
}

const rows: [string, Size, string | null, string | null, string][] = [
  ["impl", "xs", null, null, "rev-small"],
  ["impl", "xs", null, "impl-small", "rev-small"],
  ["impl", "xs", null, "impl-medium", "selector_conflict"],
  ["impl", "xs", "impl-small", null, "rev-small"],
  ["impl", "xs", "impl-small", "impl-small", "rev-small"],
  ["impl", "xs", "impl-small", "impl-medium", "selector_conflict"],
  ["impl", "xs", "impl-medium", null, "selector_conflict"],
  ["impl", "xs", "impl-medium", "impl-small", "selector_conflict"],
  ["impl", "xs", "impl-medium", "impl-medium", "selector_conflict"],
  ["impl", "s", null, null, "rev-small"],
  ["impl", "s", null, "impl-small", "rev-small"],
  ["impl", "s", null, "impl-medium", "selector_conflict"],
  ["impl", "s", "impl-small", null, "rev-small"],
  ["impl", "s", "impl-small", "impl-small", "rev-small"],
  ["impl", "s", "impl-small", "impl-medium", "selector_conflict"],
  ["impl", "s", "impl-medium", null, "selector_conflict"],
  ["impl", "s", "impl-medium", "impl-small", "selector_conflict"],
  ["impl", "s", "impl-medium", "impl-medium", "selector_conflict"],
  ["impl", "m", null, null, "rev-medium"],
  ["impl", "m", null, "impl-small", "selector_conflict"],
  ["impl", "m", null, "impl-medium", "rev-medium"],
  ["impl", "m", "impl-small", null, "selector_conflict"],
  ["impl", "m", "impl-small", "impl-small", "selector_conflict"],
  ["impl", "m", "impl-small", "impl-medium", "selector_conflict"],
  ["impl", "m", "impl-medium", null, "rev-medium"],
  ["impl", "m", "impl-medium", "impl-small", "selector_conflict"],
  ["impl", "m", "impl-medium", "impl-medium", "rev-medium"],
  ["prd", "xs", null, null, "selector_none"],
  ["prd", "xs", null, "impl-small", "selector_conflict"],
  ["prd", "xs", null, "impl-medium", "selector_conflict"],
  ["prd", "xs", "impl-small", null, "selector_conflict"],
  ["prd", "xs", "impl-small", "impl-small", "selector_conflict"],
  ["prd", "xs", "impl-small", "impl-medium", "selector_conflict"],
  ["prd", "xs", "impl-medium", null, "selector_conflict"],
  ["prd", "xs", "impl-medium", "impl-small", "selector_conflict"],
  ["prd", "xs", "impl-medium", "impl-medium", "selector_conflict"],
  ["prd", "s", null, null, "selector_none"],
  ["prd", "s", null, "impl-small", "selector_conflict"],
  ["prd", "s", null, "impl-medium", "selector_conflict"],
  ["prd", "s", "impl-small", null, "selector_conflict"],
  ["prd", "s", "impl-small", "impl-small", "selector_conflict"],
  ["prd", "s", "impl-small", "impl-medium", "selector_conflict"],
  ["prd", "s", "impl-medium", null, "selector_conflict"],
  ["prd", "s", "impl-medium", "impl-small", "selector_conflict"],
  ["prd", "s", "impl-medium", "impl-medium", "selector_conflict"],
  ["prd", "m", null, null, "selector_none"],
  ["prd", "m", null, "impl-small", "selector_conflict"],
  ["prd", "m", null, "impl-medium", "selector_conflict"],
  ["prd", "m", "impl-small", null, "selector_conflict"],
  ["prd", "m", "impl-small", "impl-small", "selector_conflict"],
  ["prd", "m", "impl-small", "impl-medium", "selector_conflict"],
  ["prd", "m", "impl-medium", null, "selector_conflict"],
  ["prd", "m", "impl-medium", "impl-small", "selector_conflict"],
  ["prd", "m", "impl-medium", "impl-medium", "selector_conflict"],
];

test.each(rows)(
  "stage %s, size %s, Kickoff %s, --process %s gives %s",
  (stage, size, kickoff, cli, expected) => {
    expect(select(stage, size, kickoff, cli, [small, medium])).toBe(expected);
  },
);

const twinRows: [string, Size, string | null, string | null, string][] = [
  ["impl", "xs", null, null, "selector_many"],
  ["impl", "s", null, null, "selector_many"],
  ["impl", "m", null, null, "rev-medium"],
  ["prd", "s", null, null, "selector_none"],
  ["impl", "s", null, "impl-small", "rev-small"],
  ["impl", "s", "impl-twin", null, "rev-twin"],
  ["impl", "s", "impl-twin", "impl-small", "selector_conflict"],
];

test.each(twinRows)(
  "with a second activation on impl-small's selector: stage %s, size %s, Kickoff %s, --process %s gives %s",
  (stage, size, kickoff, cli, expected) => {
    expect(select(stage, size, kickoff, cli, [small, medium, twin])).toBe(
      expected,
    );
  },
);

const anySize: ActiveProcess = {
  revisionId: "rev-prd",
  name: "prd",
  rev: 1,
  selector: { stage: "prd" },
};
const sizes: Size[] = ["xs", "s", "m", "l", "xl"];

test.each(sizes)(
  "a size-less prd selector fits a prd Story of size %s and no impl Story",
  (size) => {
    expect(select("prd", size, null, null, [small, medium, anySize])).toBe(
      "rev-prd",
    );
    expect(select("impl", size, null, "prd", [small, medium, anySize])).toBe(
      "selector_conflict",
    );
  },
);

test("a named Revision needs no activation, and its selector still applies", () => {
  expect(select("impl", "s", null, "impl-small", [], small)).toBe("rev-small");
  expect(select("impl", "m", null, "impl-small", [], small)).toBe(
    "selector_conflict",
  );
});

test("a name@rev that is neither active nor named is selector_none", () => {
  expect(select("impl", "s", null, "impl-large", [small, medium])).toBe(
    "selector_none",
  );
  expect(select("impl", "s", null, "impl-small", [], medium)).toBe(
    "selector_none",
  );
});
