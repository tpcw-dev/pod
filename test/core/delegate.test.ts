import { describe, expect, test } from "vitest";
import {
  contentHash,
  delegatedTrailer,
  delegatesOf,
  verifyDelegated,
  type Principals,
} from "../../src/core/gate/receipt.ts";
import type { TrackerComment } from "../../src/core/ports/tracker.ts";

const principals: Principals = {
  human: { tracker_account: "keeper-1" },
  relay: { tracker_account: "relay-1" },
};
const readbackAt = new Date("2026-11-26T12:00:00.000Z");
const quote = 'keeper-quote: 2026-11-26 "merge it"';

function comment(
  body: string,
  over: Partial<TrackerComment> = {},
): TrackerComment {
  return {
    ref: { provider: "linear", external_id: "S-1", comment_id: "c-1" },
    authorId: "keeper-1",
    body,
    editedAt: null,
    ...over,
  };
}

const delegated = (lines: string[], delegate = "scribe") =>
  ["merge PASS", "checks green", ...lines, `delegated-by: ${delegate}`].join(
    "\n",
  );

function verify(
  body: string,
  over: Partial<TrackerComment> = {},
  delegates: readonly string[] = ["scribe"],
) {
  return verifyDelegated(comment(body, over), {
    principals,
    delegates,
    keeper: "human",
    readbackAt,
  });
}

describe("verifyDelegated", () => {
  test("the accepted form returns the delegate, the whole quote line, and the full-body hash", () => {
    const body = delegated([quote]);
    expect(verify(body)).toEqual({
      ok: true,
      delegate: "scribe",
      keeper_quote: quote,
      content_hash: contentHash(body),
    });
  });

  test("a CRLF body with trailing blank lines hashes as its LF form", () => {
    const lf = delegated([quote]);
    const crlf = `${lf.replaceAll("\n", "\r\n")}\r\n\r\n`;
    expect(verify(crlf)).toMatchObject({
      ok: true,
      content_hash: contentHash(lf),
    });
  });

  test("a comment whose author is not the keeper's account is refused", () => {
    for (const authorId of ["relay-1", "worker-1", null])
      expect(verify(delegated([quote]), { authorId })).toEqual({
        ok: false,
        reason: "delegate_author_not_keeper",
        delegate: "scribe",
      });
    expect(
      verifyDelegated(comment(delegated([quote])), {
        principals: {},
        delegates: ["scribe"],
        keeper: "human",
        readbackAt,
      }),
    ).toMatchObject({ reason: "delegate_author_not_keeper" });
  });

  test("an unlisted name is refused, and so is an upper-case one", () => {
    expect(verify(delegated([quote], "other"))).toMatchObject({
      reason: "delegate_not_listed",
      delegate: "other",
    });
    expect(verify(delegated([quote], "Scribe"))).toMatchObject({
      reason: "delegate_not_listed",
      delegate: "Scribe",
    });
    expect(verify(delegated([quote]), {}, [])).toMatchObject({
      reason: "delegate_not_listed",
    });
  });

  test.each([
    [[]],
    [[quote, "more notes"]],
    [["keeper-quote: 2026-11-26 merge it"]],
    [['keeper-quote: 2026-11-26 ""']],
    [['keeper-quote: 2026-11-26 "   "']],
    [['keeper-quote: 26-11-26 "merge it"']],
  ])("quote lines %j are refused delegate_without_quote", (lines) => {
    expect(verify(delegated(lines))).toMatchObject({
      ok: false,
      reason: "delegate_without_quote",
    });
  });

  test.each([
    ['keeper-quote: 2026-02-30 "merge it"'],
    ['keeper-quote: 2026-13-01 "merge it"'],
    ['keeper-quote: 2026-11-28 "merge it"'],
  ])("%s is refused quote_date_invalid", (line) => {
    expect(verify(delegated([line]))).toMatchObject({
      ok: false,
      reason: "quote_date_invalid",
    });
  });

  test("a quote dated one day after the readback, or long before, is accepted", () => {
    for (const day of ["2026-11-27", "2025-01-01"])
      expect(
        verify(delegated([`keeper-quote: ${day} "merge it"`])),
      ).toMatchObject({ ok: true });
  });

  test("an edited comment is refused", () => {
    expect(
      verify(delegated([quote]), { editedAt: "2026-11-26T11:00:00.000Z" }),
    ).toMatchObject({ ok: false, reason: "edited" });
  });

  test("a body that is not delegated returns null", () => {
    for (const body of [
      "merge PASS",
      `merge PASS\n${quote}\nrelayed-by: s1`,
      `merge PASS\n${quote}\ndelegated-by:`,
      `merge PASS\n${quote}\ndelegated-by: Scribe Bot`,
      `merge PASS\ndelegated-by: scribe\nmore`,
    ])
      expect(verify(body)).toBeNull();
  });
});

test("delegatedTrailer reads only the last non-empty line", () => {
  expect(delegatedTrailer("merge PASS\ndelegated-by: scribe\n\n")).toEqual({
    delegate: "scribe",
  });
  expect(delegatedTrailer("merge PASS\ndelegated-by: Scribe")).toEqual({
    delegate: "Scribe",
  });
  expect(delegatedTrailer("merge PASS\nrelayed-by: s1")).toBeNull();
});

describe("delegatesOf", () => {
  test("an absent key reads as no delegates", () => {
    expect(delegatesOf({})).toEqual([]);
    expect(delegatesOf(null)).toEqual([]);
  });

  test("a valid list is returned", () => {
    expect(delegatesOf({ delegates: ["scribe", "s-2"] })).toEqual([
      "scribe",
      "s-2",
    ]);
  });

  test("a malformed value reads as no delegates", () => {
    for (const delegates of ["scribe", [1], ["Scribe"], { scribe: true }])
      expect(delegatesOf({ delegates })).toEqual([]);
  });
});
