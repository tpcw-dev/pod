import type { Size } from "../domain/ledger.ts";
import type { ProcessRef } from "../process/select.ts";

export interface TrackerPort {
  readStory(ref: StoryRef): Promise<TrackerReceipt<TrackerStory>>;
  readComment(ref: CommentRef): Promise<TrackerReceipt<TrackerComment>>;
  postComment(req: PostCommentRequest): Promise<TrackerReceipt<CommentRef>>;
  setStatus(req: SetStatusRequest): Promise<TrackerReceipt<StatusResult>>;
  readback(ref: StoryRef | CommentRef): Promise<TrackerReceipt<Readback>>;
}

export const trackerMethods = [
  "readStory",
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
