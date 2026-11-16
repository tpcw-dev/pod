import { digestCap } from "../config/digest-cap.ts";
import { packetLimits } from "../config/packet-limits.ts";
import { dayOf, scopeOf } from "../domain/digest.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import {
  digestInput,
  digestStep,
  failWindowMs,
  ruledEscalations,
} from "../operate/meta-digest.ts";
import { buildPacket } from "../operate/packet.ts";
import { readWatermark } from "../operate/watermark.ts";
import type { Repo } from "../ports/db.ts";

export interface PrepareInput {
  project: string | null;
  host: string;
  now: () => Date;
}

export async function prepareDigest(repo: Repo, input: PrepareInput) {
  const now = input.now();
  const scope = scopeOf(input.project);
  const limits = await packetLimits(repo);
  if (limits === null)
    return refuse(
      "config_missing",
      "the active global policy has no valid limits.packet_items, packet_words, and packet_minutes",
      ["pod config apply a global policy Revision with the packet limits"],
    );
  const watermark = await readWatermark(repo, "digest", digestStep, scope);
  const packet = await buildPacket(
    repo,
    digestInput,
    { host: input.host, now, scope, watermark },
    limits,
  );
  const taken = new Set(packet.items.flatMap((item) => item.subject ?? []));
  const open = await repo.listOpenProposals(scope);
  const queued = open.filter((row) => row.shown_on === null);
  const learnings = await repo.listLearnings({
    adoption: "new",
    project: input.project,
  });
  const receipts = await repo.failReceiptsSince(
    new Date(now.getTime() - failWindowMs),
    input.project,
  );
  const escalations = await ruledEscalations(
    repo,
    input.project,
    watermark?.event_id ?? 0,
  );
  return {
    ok: true as const,
    scope,
    day: dayOf(now),
    cap: await digestCap(repo, input.project),
    watermark,
    packet: {
      items: packet.items.map((item) => ({
        event_id: item.event_id,
        kind: item.kind,
        text: item.text,
      })),
      words: packet.words,
      truncated: packet.truncated,
      routing: packet.routing,
      held: packet.held,
      bound: packet.bound,
    },
    learnings: learnings
      .filter((row) => taken.has(`learning:${row.id}`))
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        area: row.area,
        text: row.text,
        expected: row.expected,
        evidence_refs: row.evidence_refs,
        source_story: row.source_story,
        occurrences: row.occurrences,
      })),
    fail_receipts: receipts
      .filter((row) => taken.has(`receipt:${row.id}`))
      .map((row) => ({
        id: row.id,
        gate_id: row.gate_id,
        run_id: row.run_id,
        task_id: row.task_id,
        scope: row.scope,
        candidate_sha: row.candidate_sha,
        keeper: row.keeper,
        created_at: row.created_at.toISOString(),
      })),
    escalations: escalations
      .filter((row) => taken.has(`decision:${row.decision_id}`))
      .map((row) => ({
        decision_id: row.decision_id,
        event_id: row.event_id,
        verb: row.verb,
        author: row.author,
        reason: row.reason,
        note: row.note,
      })),
    queued: queued.map((row) => ({
      number: row.id,
      posted_on: row.posted_on,
      theme: row.theme,
      text: row.text,
      learning_ids: row.learning_ids,
      evidence_refs: row.evidence_refs,
    })),
  };
}

export type DigestPacket = Exclude<
  Awaited<ReturnType<typeof prepareDigest>>,
  Refused
>;
