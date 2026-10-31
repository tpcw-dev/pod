import { countRun, sumCounters } from "../brief/counters.ts";
import type { Revision } from "./config.ts";
import type {
  Dispatch,
  Run,
  Story,
  Task,
  TestResult,
} from "./ledger.ts";

export interface BriefCounters {
  coordinator_operations: number;
  recovery_steps: number;
  retries: number;
  rework_tasks: number;
  hand_filled: number;
}

export interface BriefSnapshot {
  hash: string;
  pinned_at: Date;
  crew_revision_id: string;
  process_revision_id: string;
  policy_revision_id: string;
  crew: Revision | null;
  process: Revision | null;
  policy: Revision | null;
}

export interface BriefDispatch extends Dispatch {
  tests: readonly TestResult[];
}

export interface BriefRun {
  run: Run;
  snapshot: BriefSnapshot | null;
  tasks: readonly Task[];
  dispatches: readonly BriefDispatch[];
  counters: BriefCounters;
}

export interface BriefStory {
  story: Story;
  runs: readonly BriefRun[];
  counters: BriefCounters;
}

export interface BriefTree {
  stories: readonly BriefStory[];
}

export function countBriefRun(
  ...args: Parameters<typeof countRun>
): BriefCounters {
  return countRun(...args);
}

export function sumBriefCounters(
  rows: readonly BriefCounters[],
): BriefCounters {
  return sumCounters(rows);
}
