import type { Size } from "../domain/ledger.ts";
import type { ProcessRef } from "../process/select.ts";

export interface TrackerPort {
  readStory(ref: StoryRef): Promise<TrackerReceipt<TrackerStory>>;
  listStories(query: StoryQuery): Promise<TrackerReceipt<ListedStory[]>>;
  readComment(ref: CommentRef): Promise<TrackerReceipt<TrackerComment>>;
  postComment(req: PostCommentRequest): Promise<TrackerReceipt<CommentRef>>;
  setStatus(req: SetStatusRequest): Promise<TrackerReceipt<StatusResult>>;
  readback(ref: StoryRef | CommentRef): Promise<TrackerReceipt<Readback>>;
}

export const trackerMethods = [
  "readStory",
  "listStories",
  "readComment",
  "postComment",
  "setStatus",
  "readback",
] as const;
export type TrackerMethod = (typeof trackerMethods)[number];

export interface TrackerReceipt<T> {
  verb: TrackerMethod;
  ok: boolean;
  result: T | null;
  raw: unknown;
  error: string | null;
  requestId: string | null;
}

export const canceledByHuman = "canceled_by_human";
export const statusUnknown = "status_unknown";

export interface StoryRef {
  provider: string;
  external_id: string;
}

export interface CommentRef extends StoryRef {
  comment_id: string;
}

export interface TrackerStory {
  ref: StoryRef;
  title: string;
  stageLabel: string | null;
  size: Size | null;
  kickoffLine: ProcessRef | null;
  kickoffText: string | null;
  status: string;
  statusType: string;
}

export interface StoryQuery {
  project: string;
  status: string;
}

export interface ListedStory {
  ref: StoryRef;
  title: string;
  size: Size | null;
  points: number | null;
  stageLabel: string | null;
  driverLabel: string | null;
  labels: string[];
  priority: number | null;
  milestone: string | null;
  blockers: string[];
  kickoffLine: ProcessRef | null;
  createdAt: string;
}

export interface TrackerComment {
  ref: CommentRef;
  authorId: string | null;
  body: string;
  editedAt: string | null;
}

export interface PostCommentRequest {
  story: StoryRef;
  body: string;
}

export interface SetStatusRequest {
  story: StoryRef;
  status: string;
}

export interface StatusResult {
  story: TrackerStory;
}

export type Readback =
  | { kind: "story"; story: TrackerStory; comments: TrackerComment[] }
  | { kind: "comment"; comment: TrackerComment };

export interface TrackerReceiptRecord {
  verb: TrackerMethod;
  operation: string;
  variables: Record<string, unknown>;
  status: number | null;
  body: string | null;
  error: string | null;
  requestId: string | null;
  startedAt: string;
  endedAt: string;
}

export type TrackerReceiptSink = (
  record: TrackerReceiptRecord,
) => Promise<void>;

export function isCommentRef(ref: StoryRef | CommentRef): ref is CommentRef {
  return "comment_id" in ref;
}
