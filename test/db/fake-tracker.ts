import type {
  StoryRef,
  TrackerComment,
  TrackerMethod,
  TrackerPort,
  TrackerReceipt,
  TrackerStory,
} from "../../src/core/ports/tracker.ts";

export interface FakeTracker extends TrackerPort {
  calls: string[];
  comments: TrackerComment[];
  story: TrackerStory;
  failReadbacks: number[];
  dropPost: boolean;
  postLands: boolean;
  failRead: boolean;
}

export function trackerStory(over: Partial<TrackerStory> = {}): TrackerStory {
  return {
    ref: { provider: "linear", external_id: "S-1" },
    title: "Story S-1",
    stageLabel: "impl",
    size: "s",
    kickoffLine: null,
    kickoffText: null,
    status: "Backlog",
    statusType: "backlog",
    ...over,
  };
}

function receipt<T>(
  verb: TrackerMethod,
  result: T | null,
  error: string | null = null,
): TrackerReceipt<T> {
  return {
    verb,
    ok: error === null,
    result,
    raw: null,
    error,
    requestId: null,
  };
}

export function fakeTracker(story: TrackerStory = trackerStory()): FakeTracker {
  let readbacks = 0;
  const fake: FakeTracker = {
    calls: [],
    comments: [],
    story,
    failReadbacks: [],
    dropPost: false,
    postLands: true,
    failRead: false,
    readStory(ref: StoryRef) {
      fake.calls.push("readStory");
      if (fake.failRead)
        return Promise.resolve(
          receipt<TrackerStory>("readStory", null, "timeout"),
        );
      return Promise.resolve(
        receipt<TrackerStory>(
          "readStory",
          ref.external_id === fake.story.ref.external_id ? fake.story : null,
        ),
      );
    },
    readComment(ref) {
      fake.calls.push("readComment");
      const found = fake.comments.find(
        (comment) => comment.ref.comment_id === ref.comment_id,
      );
      return Promise.resolve(
        receipt<TrackerComment>(
          "readComment",
          found ?? null,
          found === undefined ? "not_found" : null,
        ),
      );
    },
    postComment(req) {
      fake.calls.push("postComment");
      const ref = { ...req.story, comment_id: `c-${fake.comments.length + 1}` };
      if (fake.postLands)
        fake.comments.push({
          ref,
          authorId: "bot",
          body: req.body,
          editedAt: null,
        });
      return Promise.resolve(
        fake.dropPost
          ? receipt<typeof ref>("postComment", null, "dropped")
          : receipt("postComment", ref),
      );
    },
    setStatus(req) {
      fake.calls.push("setStatus");
      if (fake.failRead)
        return Promise.resolve(
          receipt<{ story: TrackerStory }>("setStatus", null, "timeout"),
        );
      if (fake.story.statusType === "canceled")
        return Promise.resolve(
          receipt("setStatus", { story: fake.story }, "canceled_by_human"),
        );
      fake.calls.push("setStatus:mutation");
      fake.story = { ...fake.story, status: req.status, statusType: "started" };
      return Promise.resolve(receipt("setStatus", { story: fake.story }));
    },
    readback() {
      fake.calls.push("readback");
      readbacks += 1;
      if (fake.failReadbacks.includes(readbacks))
        return Promise.resolve(
          receipt<never>("readback", null, "readback_incomplete"),
        );
      return Promise.resolve(
        receipt("readback", {
          kind: "story" as const,
          story: fake.story,
          comments: [...fake.comments],
        }),
      );
    },
  };
  return fake;
}
