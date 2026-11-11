import { singleActive } from "../config/active.ts";
import {
  activateComment,
  type ActivationSource,
  type PendingActivation,
} from "../config/apply.ts";
import { parseRuling, rulingConsumed, type Ruling } from "../decide/ruling.ts";
import type { Run } from "../domain/ledger.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type {
  StoryRef,
  TrackerComment,
  TrackerPort,
} from "../ports/tracker.ts";
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

type HumanPrincipal = (
  comment: TrackerComment,
) => Promise<{ ok: true; principal: string } | { ok: false; reason: string }>;

function humanPrincipal(
  tracker: TrackerPort,
  policy: unknown,
  input: Pick<RulingInput, "hostName" | "bypassPath">,
): HumanPrincipal {
  const keepers = hqaKeepers(policy);
  const principals = principalsOf(policy);
  const bypass =
    input.bypassPath === undefined || input.hostName === undefined
      ? null
      : readBypass(input.bypassPath, input.hostName);
  return (comment) =>
    verifiedKeeper(tracker, comment, keepers, (keeper) =>
      verifySource(comment, principals, keeper, bypass),
    );
}

export function humanSource(
  tracker: TrackerPort,
  policy: unknown,
  input: Pick<RulingInput, "hostName" | "bypassPath">,
): HumanSource {
  const verify = humanPrincipal(tracker, policy, input);
  return async (comment) => {
    const checked = await verify(comment);
    return checked.ok ? null : checked.reason;
  };
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

export interface ActivationReadback {
  revision_id: string;
  source: Extract<ActivationSource, { kind: "tracker_comment" }>;
  activated_by: string;
}

function requestLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function acceptedLines({ request }: PendingActivation): string[] {
  const line = activateComment(request.revision_id);
  return request.comment === line ? [line] : [line, request.comment];
}

function requestName({ request }: PendingActivation): string {
  return `${request.profile === null ? "config activate" : "profile"} request ${JSON.stringify(request.comment)}`;
}

export interface ActivationInput extends RulingInput {
  log: ReceiptLog;
  storyComments: readonly TrackerComment[] | null;
}

async function ticketComments(
  tracker: TrackerPort,
  input: ActivationInput,
  ticket: string | null,
): Promise<StoryComments> {
  if (ticket === null)
    return input.storyComments === null
      ? { ok: false, error: "story read failed" }
      : { ok: true, comments: [...input.storyComments] };
  const ref: StoryRef = {
    provider: input.run.story_provider,
    external_id: ticket,
  };
  input.log.at({ run_id: input.run.run_id, task_id: null, op_key: null });
  const read = await tracker.readback(ref);
  if (!read.ok || read.result?.kind !== "story")
    return { ok: false, error: read.error ?? "no story" };
  return { ok: true, comments: read.result.comments };
}

export async function verifiedActivations(
  db: Db,
  tracker: TrackerPort,
  pending: readonly PendingActivation[],
  input: ActivationInput,
): Promise<{ readbacks: ActivationReadback[]; nextSteps: string[] }> {
  const readbacks: ActivationReadback[] = [];
  const nextSteps: string[] = [];
  const global = await singleActive(db, "policy", "global", "");
  const verify = humanPrincipal(tracker, global?.value, input);
  const reads = new Map<string | null, StoryComments>();
  const spent = new Set<string>();
  const settled = new Set<string>();
  for (const row of pending) {
    const { revision_id, ticket } = row.request;
    if (settled.has(revision_id)) continue;
    let read = reads.get(ticket);
    if (read === undefined) {
      read = await ticketComments(tracker, input, ticket);
      reads.set(ticket, read);
      if (!read.ok && ticket !== null)
        nextSteps.push(
          `tracker readback of ticket ${ticket ?? ""} failed: ${read.error}; its config activate requests wait for the next pod check`,
        );
    }
    if (!read.ok) continue;
    const lines = acceptedLines(row);
    for (const comment of read.comments) {
      const id = comment.ref.comment_id;
      if (!lines.includes(requestLine(comment.body))) continue;
      if (spent.has(id) || (await db.commentSpent(id))) continue;
      const checked =
        comment.editedAt === null
          ? await verify(comment)
          : ({ ok: false, reason: "edited" } as const);
      if (!checked.ok) {
        nextSteps.push(
          `receipt_unverified_source: ${requestName(row)} comment ${id} by ${comment.authorId ?? "an unknown author"} is not a verified human source (${checked.reason}); the request stays pending`,
        );
        continue;
      }
      spent.add(id);
      settled.add(revision_id);
      readbacks.push({
        revision_id,
        source: {
          kind: "tracker_comment",
          comment_id: id,
          author: comment.authorId ?? "",
          readback_at: input.now().toISOString(),
        },
        activated_by: `person:${checked.principal}`,
      });
      break;
    }
  }
  return { readbacks, nextSteps };
}

async function verifiedKeeper(
  tracker: TrackerPort,
  comment: TrackerComment,
  keepers: readonly string[],
  verify: (keeper: string) => ReturnType<typeof verifySource>,
): Promise<{ ok: true; principal: string } | { ok: false; reason: string }> {
  if (keepers.length === 0) return { ok: false, reason: "no_hqa_keeper" };
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
      return { ok: false, reason: "readback_differs" };
    return {
      ok: true,
      principal: source.relayed_by === null ? keeper : "relay",
    };
  }
  return { ok: false, reason: reason ?? "not_a_human_source" };
}
