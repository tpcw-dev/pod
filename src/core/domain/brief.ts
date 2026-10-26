import type { Revision } from "./config.ts";
import type { Dispatch, Run, Story, Task } from "./ledger.ts";

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

export interface BriefRun {
  run: Run;
  snapshot: BriefSnapshot | null;
  tasks: readonly Task[];
  dispatches: readonly Dispatch[];
}

export interface BriefStory {
  story: Story;
  runs: readonly BriefRun[];
}

export interface BriefTree {
  stories: readonly BriefStory[];
}
