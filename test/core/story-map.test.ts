import { describe, expect, test } from "vitest";
import { kickoffOf, sizeOf, stageOf } from "../../src/adapters/linear/map.ts";

describe("estimate to size", () => {
  test("fibonacci maps 1, 2, 3, 5, 8 and nothing else", () => {
    expect([1, 2, 3, 5, 8].map((n) => sizeOf(n, "fibonacci"))).toEqual([
      "xs",
      "s",
      "m",
      "l",
      "xl",
    ]);
    expect(sizeOf(4, "fibonacci")).toBeNull();
    expect(sizeOf(0, "fibonacci")).toBeNull();
    expect(sizeOf(null, "fibonacci")).toBeNull();
  });

  test("tshirt maps 1 to 5 and nothing else", () => {
    expect([1, 2, 3, 4, 5].map((n) => sizeOf(n, "tshirt"))).toEqual([
      "xs",
      "s",
      "m",
      "l",
      "xl",
    ]);
    expect(sizeOf(8, "tshirt")).toBeNull();
  });

  test("an unknown scale maps every estimate to null", () => {
    expect(sizeOf(3, "linear")).toBeNull();
  });
});

describe("stage label", () => {
  test("exactly one stage: label names the stage", () => {
    expect(stageOf(["meta", "stage:impl"])).toBe("impl");
  });

  test("no stage label, two stage labels, or an empty stage is null", () => {
    expect(stageOf(["meta"])).toBeNull();
    expect(stageOf(["stage:impl", "stage:prd"])).toBeNull();
    expect(stageOf(["stage:"])).toBeNull();
  });
});

describe("Kickoff line", () => {
  test("name@rev parses to a process ref", () => {
    expect(kickoffOf("Intro\n\nKickoff: impl-small@1\n")).toEqual({
      name: "impl-small",
      rev: 1,
    });
  });

  test("the S3-era lean form and other words parse to null", () => {
    expect(kickoffOf("Kickoff: lean")).toBeNull();
    expect(kickoffOf("Kickoff: impl@0")).toBeNull();
    expect(kickoffOf("Kickoff: impl@1 now")).toBeNull();
    expect(kickoffOf("Kickoff:")).toBeNull();
  });

  test("only the first Kickoff line is read", () => {
    expect(kickoffOf("Kickoff: lean\nKickoff: impl@2")).toBeNull();
    expect(kickoffOf("Kickoff: impl@2\nKickoff: lean")).toEqual({
      name: "impl",
      rev: 2,
    });
  });

  test("no description or no Kickoff line is null", () => {
    expect(kickoffOf(null)).toBeNull();
    expect(kickoffOf("Goal\n\nnothing here")).toBeNull();
  });
});
