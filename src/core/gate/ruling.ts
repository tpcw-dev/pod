import { singleActive } from "../config/active.ts";
import type { PendingProfileOp, ProfileSource } from "../config/apply.ts";
import { parseRuling, rulingConsumed, type Ruling } from "../decide/ruling.ts";
import type { Run } from "../domain/ledger.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { TrackerComment, TrackerPort } from "../ports/tracker.ts";
import { readBypass } from "./bypass.ts";
import {
  hashOf,
  hqaKeepers,
  pinnedConfig,
  principalsOf,
  verifySource,
} from "./receipt.ts";

export interface RulingInput {
  run: Run;
  hostName?: string | undefined;
  bypassPath?: string | undefined;
  now: () => Date;
}

interface Verified {
  ruling: Ruling;
  consumed: boolean;
}

export type StoryComments =
  { ok: true; comments: TrackerComment[] } | { ok: false; error: string };

export async function readStoryComments(
  tracker: TrackerPort,
  log: ReceiptLog,
  run: Run,
): Promise<StoryComments> {
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const read = await tracker.readback({
    provider: run.story_provider,
    external_id: run.story_external_id,
  });
  if (!read.ok || read.result?.kind !== "story")
    return { ok: false, error: read.error ?? "no story" };
  return { ok: true, comments: read.result.comments };
}

export async function waitingDecisions(
  db: Db,
  runId: string,
): Promise<Set<string>> {
  return new Set(
    (await db.listRunDecisions(runId))
      .filter((row) => row.state === "needs_human")
      .map((row) => row.id),
  );
}

export type HumanSource = (comment: TrackerComment) => Promise<string | null>;

export function humanSource(
  tracker: TrackerPort,
  policy: unknown,
  input: Pick<RulingInput, "hostName" | "bypassPath">,
): HumanSource {
  const keepers = hqaKeepers(policy);
  const principals = principalsOf(policy);
  const bypass =
    input.bypassPath === undefined || input.hostName === undefined
      ? null
      : readBypass(input.bypassPath, input.hostName);
  return (comment) =>
    refusal(tracker, comment, keepers, (keeper) =>
      verifySource(comment, principals, keeper, bypass),
    );
}

export async function verifiedRulings(
  db: Db,
  tracker: TrackerPort,
  comments: readonly TrackerComment[],
  input: RulingInput,
): Promise<{ rulings: Ruling[]; nextSteps: string[] }> {
  const { run } = input;
  const waiting = await waitingDecisions(db, run.run_id);
  const nextSteps: string[] = [];
  if (waiting.size === 0) return { rulings: [], nextSteps };
  const pinned = await pinnedConfig(db, run.run_id);
  const verify = humanSource(tracker, pinned?.policy, input);
  const found = new Map<string, Verified[]>();
  for (const comment of comments) {
    const text = parseRuling(comment.body);
    if (text === null || !waiting.has(text.decision_id)) continue;
    const reason = await verify(comment);
    if (reason !== null) {
      nextSteps.push(
        `receipt_unverified_source: Decision ${text.decision_id} ruling comment ${comment.ref.comment_id} by ${comment.authorId ?? "an unknown author"} is not a verified human source (${reason}); the Decision stays needs_human`,
      );
      continue;
    }
    const ruling: Ruling = {
      ...text,
      comment_id: comment.ref.comment_id,
      author: comment.authorId ?? "",
      readback_at: input.now().toISOString(),
    };
    const list = found.get(text.decision_id) ?? [];
    list.push({
      ruling,
      consumed: await rulingConsumed(db, text.decision_id, ruling.comment_id),
    });
    found.set(text.decision_id, list);
  }
  const rulings: Ruling[] = [];
  for (const [id, list] of found) {
    const [first] = list;
    if (first === undefined || first.consumed) continue;
    const other = list.find(
      (row) => !row.consumed && row.ruling.verb !== first.ruling.verb,
    );
    if (other !== undefined) {
      nextSteps.push(
        `Decision ${id} has conflicting rulings ${first.ruling.comment_id} and ${other.ruling.comment_id}; post one new ruling`,
      );
      continue;
    }
    rulings.push(first.ruling);
  }
  return { rulings, nextSteps };
}

export interface ProfileReadback {
  op_key: string;
  source: ProfileSource;
}

function requestLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export async function verifiedProfileRequests(
  db: Db,
  tracker: TrackerPort,
  comments: readonly TrackerComment[],
  pending: readonly PendingProfileOp[],
  input: RulingInput,
): Promise<{ readbacks: ProfileReadback[]; nextSteps: string[] }> {
  const readbacks: ProfileReadback[] = [];
  const nextSteps: string[] = [];
  for (const { op_key, request } of pending) {
    const posted = comments.filter(
      (comment) => requestLine(comment.body) === request.comment,
    );
    if (posted.length === 0) continue;
    const current = await singleActive(
      db,
      "policy",
      request.scope,
      request.scope_ref,
    );
    const verify = humanSource(tracker, current?.value, input);
    for (const comment of posted) {
      const reason = await verify(comment);
      if (reason !== null) {
        nextSteps.push(
          `receipt_unverified_source: profile request ${JSON.stringify(request.comment)} comment ${comment.ref.comment_id} by ${comment.authorId ?? "an unknown author"} is not a verified human source (${reason}); the request stays pending`,
        );
        continue;
      }
      readbacks.push({
        op_key,
        source: {
          comment_id: comment.ref.comment_id,
          author: comment.authorId ?? "",
          readback_at: input.now().toISOString(),
        },
      });
      break;
    }
  }
  return { readbacks, nextSteps };
}

async function refusal(
  tracker: TrackerPort,
  comment: TrackerComment,
  keepers: readonly string[],
  verify: (keeper: string) => ReturnType<typeof verifySource>,
): Promise<string | null> {
  if (keepers.length === 0) return "no_hqa_keeper";
  let reason: string | null = null;
  for (const keeper of keepers) {
    const source = verify(keeper);
    if (!source.ok) {
      reason ??= source.reason;
      continue;
    }
    const confirm = await tracker.readComment(comment.ref);
    if (
      !confirm.ok ||
      confirm.result === null ||
      hashOf(confirm.result.body, source.relayed_by) !== source.content_hash
    )
      return "readback_differs";
    return null;
  }
  return reason;
}
