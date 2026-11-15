import { attend, type AttentionPort } from "../../src/core/operate/attention.ts";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import { operateSteps, type TickStep } from "../../src/core/operate/tick.ts";
import type { Db } from "../../src/core/ports/db.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import { fakeGit } from "./close-ports.ts";

export function idleSteps(db: Db): readonly TickStep[] {
  return operateSteps({
    orca: noCalls(),
    tracker: null,
    log: receiptLog(db, "local"),
    codeHost: makeFixtureCodeHost(),
    git: fakeGit(),
    worktreeStatus: () => null,
    gitStatus: () => "## main",
    provider: "linear",
    leaseSeconds: launchLeaseSeconds,
  });
}

export function withAttention(
  steps: readonly TickStep[],
  port: AttentionPort,
): readonly TickStep[] {
  return steps.map((step) =>
    step.name === "attention"
      ? { ...step, run: (ctx) => attend(ctx.db, port, ctx) }
      : step,
  );
}
