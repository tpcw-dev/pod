import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readBypass } from "../../src/core/gate/bypass.ts";
import {
  contentHash,
  findVerdictComment,
  gateOf,
  principalsOf,
  shaMatches,
  verifySource,
  type Principals,
} from "../../src/core/gate/receipt.ts";
import type { TrackerComment } from "../../src/core/ports/tracker.ts";

const candidate = "0123456789abcdef0123456789abcdef01234567";

describe("shaMatches", () => {
  test("a 7-char prefix and the full SHA match", () => {
    expect(shaMatches("0123456", candidate)).toBe(true);
    expect(shaMatches(candidate, candidate)).toBe(true);
  });

  test("uppercase, 6 chars, and a non-prefix are refused", () => {
    expect(shaMatches("0123456789ABCDEF", candidate)).toBe(false);
    expect(shaMatches("012345", candidate)).toBe(false);
    expect(shaMatches("1234567", candidate)).toBe(false);
    expect(shaMatches(`${candidate}0`, candidate)).toBe(false);
    expect(shaMatches("ABCDEF0", "ABCDEF0123")).toBe(false);
  });
});

test("contentHash folds CRLF and trailing whitespace", () => {
  expect(contentHash("review PASS\r\nHead: abc\r\n  \n")).toBe(
    contentHash("review PASS\nHead: abc"),
  );
  expect(contentHash("review PASS")).not.toBe(contentHash("review FAIL"));
});

function comment(id: string, body: string, authorId = "keeper-1") {
  return {
    ref: { provider: "linear", external_id: "S-1", comment_id: id },
    authorId,
    body,
    editedAt: null,
  } satisfies TrackerComment;
}

describe("findVerdictComment", () => {
  test("the bare form and the prefixed form both match", () => {
    expect(
      findVerdictComment([comment("c1", "review PASS")], "review"),
    ).toMatchObject({ outcome: "PASS", comment: { ref: { comment_id: "c1" } } });
    expect(
      findVerdictComment([comment("c1", "jerry: review FAIL\nnotes")], "review")
        ?.outcome,
    ).toBe("FAIL");
  });

  test("leading blank lines are skipped and the newest comment wins", () => {
    const found = findVerdictComment(
      [comment("new", "\n\n  review FAIL  \n"), comment("old", "review PASS")],
      "review",
    );
    expect(found).toMatchObject({
      outcome: "FAIL",
      comment: { ref: { comment_id: "new" } },
    });
  });

  test("another gate, a longer word, or a non-first line is no verdict", () => {
    for (const body of [
      "merge PASS",
      "review PASSED",
      "looks good\nreview PASS",
      "a review PASS",
    ])
      expect(findVerdictComment([comment("c", body)], "review")).toBeNull();
  });

  test("a gate id with regex characters is matched literally", () => {
    expect(findVerdictComment([comment("c", "aXb PASS")], "a.b")).toBeNull();
    expect(
      findVerdictComment([comment("c", "a.b PASS")], "a.b")?.outcome,
    ).toBe("PASS");
  });
});

describe("verifySource", () => {
  const principals: Principals = {
    human: { tracker_account: "keeper-1" },
    relay: { tracker_account: "relay-1" },
  };
  const pass = { result: "pass", at: "2026-10-31T00:00:00.000Z" } as const;

  test("the keeper's own account is accepted, hashed over the whole body", () => {
    expect(
      verifySource(comment("c", "review PASS"), principals, "human", pass),
    ).toEqual({
      ok: true,
      relayed_by: null,
      content_hash: contentHash("review PASS"),
    });
  });

  test("the relay with a trailer is accepted, hashed without the trailer", () => {
    const body = "review PASS\nrelayed-by: session-9\n";
    expect(
      verifySource(comment("c", body, "relay-1"), principals, "human", pass),
    ).toEqual({
      ok: true,
      relayed_by: "session-9",
      content_hash: contentHash("review PASS"),
    });
  });

  test("the relay without a trailer, a worker, and no author are refused", () => {
    expect(
      verifySource(
        comment("c", "review PASS", "relay-1"),
        principals,
        "human",
        pass,
      ),
    ).toEqual({ ok: false, reason: "relay_without_trailer" });
    expect(
      verifySource(
        comment("c", "review PASS", "worker-1"),
        principals,
        "human",
        pass,
      ),
    ).toEqual({ ok: false, reason: "not_a_human_source" });
    expect(
      verifySource(
        { ...comment("c", "review PASS"), authorId: null },
        principals,
        "human",
        pass,
      ),
    ).toEqual({ ok: false, reason: "no_author" });
  });

  test("a missing or failed bypass result refuses even the keeper", () => {
    const keeper = comment("c", "review PASS");
    expect(verifySource(keeper, principals, "human", null)).toEqual({
      ok: false,
      reason: "bypass_missing",
    });
    expect(
      verifySource(keeper, principals, "human", { ...pass, result: "fail" }),
    ).toEqual({ ok: false, reason: "bypass_failed" });
  });

  test("a keeper with no principal accepts nobody", () => {
    expect(
      verifySource(comment("c", "review PASS"), principals, "other", pass),
    ).toEqual({ ok: false, reason: "not_a_human_source" });
  });
});

describe("policy reads", () => {
  test("gateOf reads the map and the array form, and refuses a bare string", () => {
    const map = { gates: { review: { keeper: "human", type: "HQA" } } };
    const list = { gates: [{ id: "review", keeper: "bot", type: "AQA" }] };
    expect(gateOf(map, "review")).toEqual({ keeper: "human", type: "HQA" });
    expect(gateOf(list, "review")).toEqual({ keeper: "bot", type: "AQA" });
    expect(gateOf({ gates: ["review"] }, "review")).toBeNull();
    expect(gateOf(map, "merge")).toBeNull();
    expect(
      gateOf({ gates: { review: { keeper: "human", type: "X" } } }, "review"),
    ).toBeNull();
  });

  test("principalsOf drops malformed entries", () => {
    expect(
      principalsOf({
        principals: {
          human: { tracker_account: "keeper-1" },
          broken: { tracker_account: 7 },
          other: "x",
        },
      }),
    ).toEqual({ human: { tracker_account: "keeper-1" } });
    expect(principalsOf({})).toEqual({});
  });
});

describe("readBypass", () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-bypass-"));

  test("a missing file is null", () => {
    expect(readBypass(join(dir, "none.jsonl"), "h1")).toBeNull();
  });

  test("the newest well-formed line for this host wins", () => {
    const path = join(dir, "bypass.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ host: "h1", result: "fail", at: "t1" })}\n`,
    );
    appendFileSync(
      path,
      `${JSON.stringify({ host: "h1", result: "pass", at: "t2" })}\n`,
    );
    appendFileSync(
      path,
      `${JSON.stringify({ host: "h2", result: "fail", at: "t3" })}\n`,
    );
    appendFileSync(path, `{"host":"h1","result":"fa`);
    expect(readBypass(path, "h1")).toEqual({ result: "pass", at: "t2" });
    expect(readBypass(path, "h2")).toEqual({ result: "fail", at: "t3" });
    expect(readBypass(path, "h3")).toBeNull();
  });
});
