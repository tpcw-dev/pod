import { readFileSync } from "node:fs";
import { z } from "zod";
import { PrState, type CodeHostPort } from "../../core/ports/code-host.ts";

export const CodeHostFixture = z.object({
  prs: z.array(PrState).default([]),
  open: z.record(z.string(), z.array(z.int())).default({}),
  unreadable: z.boolean().default(false),
});
export type CodeHostFixture = z.input<typeof CodeHostFixture>;

export interface FixtureCodeHost extends CodeHostPort {
  calls: string[];
}

export function makeFixtureCodeHost(
  fixture: CodeHostFixture = {},
): FixtureCodeHost {
  const data = CodeHostFixture.parse(fixture);
  const calls: string[] = [];
  return {
    calls,
    pr(_repo, number) {
      calls.push(`pr ${number}`);
      if (data.unreadable) return Promise.resolve(null);
      return Promise.resolve(
        data.prs.find((row) => row.number === number) ?? null,
      );
    },
    openPrs(_repo, branch) {
      calls.push(`open ${branch}`);
      if (data.unreadable) return Promise.resolve(null);
      return Promise.resolve(data.open[branch] ?? []);
    },
  };
}

export function loadFixtureCodeHost(path: string): FixtureCodeHost {
  return makeFixtureCodeHost(
    CodeHostFixture.parse(JSON.parse(readFileSync(path, "utf8"))),
  );
}
