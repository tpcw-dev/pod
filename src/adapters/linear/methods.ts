import { z } from "zod";
import {
  canceledByHuman,
  isCommentRef,
  type CommentRef,
  type Readback,
  type StatusResult,
  type StoryRef,
  type TrackerComment,
  type TrackerMethod,
  type TrackerPort,
  type TrackerReceipt,
} from "../../core/ports/tracker.ts";
import { decode, type GraphqlRequest, type HttpReply } from "./client.ts";
import { commentOf, LinearComment, LinearIssue, storyOf } from "./map.ts";

export type Send = (
  verb: TrackerMethod,
  request: GraphqlRequest,
) => Promise<HttpReply>;

export const maxCommentPages = 40;

const Page = z.looseObject({
  comments: z.looseObject({
    nodes: z.array(LinearComment),
    pageInfo: z.looseObject({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullish(),
    }),
  }),
});

const CommentWithIssue = LinearComment.extend({
  issue: z.looseObject({ identifier: z.string() }).nullish(),
});

const Posted = z.looseObject({
  success: z.boolean(),
  comment: LinearComment.nullish(),
});

const Updated = z.looseObject({
  success: z.boolean(),
  issue: LinearIssue.nullish(),
});

function receipt<T>(
  verb: TrackerMethod,
  ok: boolean,
  result: T | null,
  raw: unknown,
  error: string | null,
  requestId: string | null,
): TrackerReceipt<T> {
  return { verb, ok, result, raw, error, requestId };
}

export function trackerMethods(send: Send, scale: string): TrackerPort {
  async function story(verb: TrackerMethod, ref: StoryRef) {
    const reply = await send(verb, {
      operation: "Story",
      variables: { id: ref.external_id },
    });
    const decoded = decode(reply, (data) => data["issue"], LinearIssue);
    return { reply, decoded };
  }

  async function comments(verb: TrackerMethod, ref: StoryRef) {
    const all: TrackerComment[] = [];
    const raws: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxCommentPages; page += 1) {
      const reply = await send(verb, {
        operation: "StoryComments",
        variables: { id: ref.external_id, after },
      });
      const decoded = decode(reply, (data) => data["issue"], Page);
      raws.push(decoded.raw);
      if (!decoded.ok || decoded.result === null)
        return {
          ok: false as const,
          raws,
          error: decoded.error ?? "readback_incomplete",
        };
      const { nodes, pageInfo } = decoded.result.comments;
      all.push(...nodes.map((node) => commentOf(ref, node)));
      if (!pageInfo.hasNextPage) return { ok: true as const, raws, all };
      if (pageInfo.endCursor == null)
        return { ok: false as const, raws, error: "readback_incomplete" };
      after = pageInfo.endCursor;
    }
    return { ok: false as const, raws, error: "readback_incomplete" };
  }

  async function readComment(verb: TrackerMethod, ref: CommentRef) {
    const reply = await send(verb, {
      operation: "Comment",
      variables: { id: ref.comment_id },
    });
    const decoded = decode(reply, (data) => data["comment"], CommentWithIssue);
    return {
      reply,
      decoded,
      comment: decoded.result === null ? null : commentOf(ref, decoded.result),
    };
  }

  return {
    async readStory(ref) {
      const { reply, decoded } = await story("readStory", ref);
      return receipt(
        "readStory",
        decoded.ok,
        decoded.result === null
          ? null
          : storyOf(ref.provider, decoded.result, scale),
        decoded.raw,
        decoded.error,
        reply.requestId,
      );
    },

    async readComment(ref) {
      const { reply, decoded, comment } = await readComment("readComment", ref);
      return receipt(
        "readComment",
        decoded.ok,
        comment,
        decoded.raw,
        decoded.error,
        reply.requestId,
      );
    },

    async postComment(req) {
      const reply = await send("postComment", {
        operation: "PostComment",
        variables: { issueId: req.story.external_id, body: req.body },
      });
      const decoded = decode(reply, (data) => data["commentCreate"], Posted);
      const posted = decoded.result;
      if (
        decoded.ok &&
        (posted === null || !posted.success || posted.comment == null)
      )
        return receipt<CommentRef>(
          "postComment",
          false,
          null,
          decoded.raw,
          "not_success",
          reply.requestId,
        );
      return receipt<CommentRef>(
        "postComment",
        decoded.ok,
        posted?.comment == null
          ? null
          : { ...req.story, comment_id: posted.comment.id },
        decoded.raw,
        decoded.error,
        reply.requestId,
      );
    },

    async setStatus(req) {
      const read = await story("setStatus", req.story);
      if (!read.decoded.ok)
        return receipt<StatusResult>(
          "setStatus",
          false,
          null,
          read.decoded.raw,
          read.decoded.error,
          read.reply.requestId,
        );
      const issue = read.decoded.result;
      if (issue === null)
        return receipt<StatusResult>(
          "setStatus",
          false,
          null,
          read.decoded.raw,
          "story_not_found",
          read.reply.requestId,
        );
      const found = storyOf(req.story.provider, issue, scale);
      if (issue.state.type === "canceled")
        return receipt<StatusResult>(
          "setStatus",
          false,
          { story: found },
          read.decoded.raw,
          canceledByHuman,
          read.reply.requestId,
        );
      const state = issue.team.states.nodes.find(
        (node) => node.name === req.status,
      );
      if (state === undefined)
        return receipt<StatusResult>(
          "setStatus",
          false,
          { story: found },
          read.decoded.raw,
          "status_unknown",
          read.reply.requestId,
        );
      const reply = await send("setStatus", {
        operation: "SetStatus",
        variables: { id: req.story.external_id, stateId: state.id },
      });
      const decoded = decode(reply, (data) => data["issueUpdate"], Updated);
      const updated = decoded.result;
      if (
        decoded.ok &&
        (updated === null || !updated.success || updated.issue == null)
      )
        return receipt<StatusResult>(
          "setStatus",
          false,
          null,
          decoded.raw,
          "not_success",
          reply.requestId,
        );
      return receipt<StatusResult>(
        "setStatus",
        decoded.ok,
        updated?.issue == null
          ? null
          : { story: storyOf(req.story.provider, updated.issue, scale) },
        decoded.raw,
        decoded.error,
        reply.requestId,
      );
    },

    async readback(ref) {
      if (isCommentRef(ref)) {
        const { reply, decoded, comment } = await readComment("readback", ref);
        return receipt<Readback>(
          "readback",
          decoded.ok,
          comment === null ? null : { kind: "comment" as const, comment },
          decoded.raw,
          decoded.error,
          reply.requestId,
        );
      }
      const read = await story("readback", ref);
      if (!read.decoded.ok || read.decoded.result === null)
        return receipt<Readback>(
          "readback",
          read.decoded.ok,
          null,
          read.decoded.raw,
          read.decoded.error,
          read.reply.requestId,
        );
      const pages = await comments("readback", ref);
      const raw = { story: read.decoded.raw, pages: pages.raws };
      if (!pages.ok)
        return receipt<Readback>(
          "readback",
          false,
          null,
          raw,
          pages.error,
          read.reply.requestId,
        );
      return receipt<Readback>(
        "readback",
        true,
        {
          kind: "story" as const,
          story: storyOf(ref.provider, read.decoded.result, scale),
          comments: pages.all,
        },
        raw,
        null,
        read.reply.requestId,
      );
    },
  };
}
