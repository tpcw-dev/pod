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

export async function verifiedRulings(
  db: Db,
  tracker: TrackerPort,
  log: ReceiptLog,
  input: RulingInput,
): Promise<{ rulings: Ruling[]; nextSteps: string[] }> {
  const { run } = input;
  const waiting = new Set(
    (await db.listRunDecisions(run.run_id))
      .filter((row) => row.state === "needs_human")
      .map((row) => row.id),
  );
  const nextSteps: string[] = [];
  if (waiting.size === 0) return { rulings: [], nextSteps };
  log.at({ run_id: run.run_id, task_id: null, op_key: null });
  const read = await tracker.readback({
    provider: run.story_provider,
    external_id: run.story_external_id,
  });
  if (!read.ok || read.result?.kind !== "story") {
    nextSteps.push(
      `tracker readback of story:${run.story_external_id} failed: ${read.error ?? "no story"}; Decision rulings wait for the next pod check`,
    );
    return { rulings: [], nextSteps };
  }
  const pinned = await pinnedConfig(db, run.run_id);
  const keepers = hqaKeepers(pinned?.policy);
  const principals = principalsOf(pinned?.policy);
  const bypass =
    input.bypassPath === undefined || input.hostName === undefined
      ? null
      : readBypass(input.bypassPath, input.hostName);
  const found = new Map<string, Verified[]>();
  for (const comment of read.result.comments) {
    const text = parseRuling(comment.body);
    if (text === null || !waiting.has(text.decision_id)) continue;
    const reason = await refusal(tracker, comment, keepers, (keeper) =>
      verifySource(comment, principals, keeper, bypass),
    );
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
