import type { WorktreeStatus } from "../domain/close.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { CodeHostPort } from "../ports/code-host.ts";
import type { GitPort } from "../ports/git.ts";
import type { OrcaPort } from "../ports/orca.ts";
import type { TrackerPort } from "../ports/tracker.ts";

export interface OperatePorts {
  orca: OrcaPort;
  tracker: TrackerPort | null;
  log: ReceiptLog;
  codeHost: CodeHostPort;
  git: GitPort;
  worktreeStatus: (path: string) => WorktreeStatus | null;
  gitStatus: (path: string) => string;
  provider: string;
  leaseSeconds: number;
}
