import type { Watermark } from "../domain/tick.ts";
import { countWords } from "../manifest/task-view.ts";
import type { Repo } from "../ports/db.ts";

export interface PacketItem {
  event_id: number;
  ts: Date;
  kind: "evidence" | "ruling" | "exception";
  text: string;
}

export interface PacketContext {
  host: string;
  now: Date;
  scope: string;
  watermark: Watermark | null;
}

/**
 * A meta step's input query: evidence changed or unread since the watermark,
 * the step's earlier rulings or Decisions, and open exceptions.
 */
export type PacketInput = (
  repo: Repo,
  ctx: PacketContext,
) => Promise<PacketItem[]>;

export interface Packet {
  items: PacketItem[];
  words: number;
  truncated: boolean;
  routing: string | null;
  held: number;
  bound: Watermark | null;
}

function newer(a: Watermark | null, item: PacketItem | undefined) {
  if (item === undefined || (a !== null && a.event_id >= item.event_id))
    return a;
  return { event_id: item.event_id, ts: item.ts.toISOString() };
}

/**
 * Sorts oldest first and cuts at the item and word caps. The first item is
 * always taken, so one oversized item cannot stall the step. Items past the
 * cap stay newer than the bound, so the next packet reads them first.
 */
export function cutPacket(
  items: readonly PacketItem[],
  limits: { items: number; words: number },
  watermark: Watermark | null,
): Packet {
  const sorted = [
    ...new Map(items.map((item) => [item.event_id, item])).values(),
  ].sort((a, b) => a.event_id - b.event_id);
  const taken: PacketItem[] = [];
  let words = 0;
  for (const item of sorted) {
    const size = countWords(item.text);
    if (
      taken.length > 0 &&
      (taken.length >= limits.items || words + size > limits.words)
    )
      break;
    taken.push(item);
    words += size;
  }
  const held = sorted.length - taken.length;
  const next = sorted[taken.length];
  return {
    items: taken,
    words,
    truncated: held > 0,
    routing:
      next === undefined
        ? null
        : `truncated: ${held} items held for the next packet, oldest event ${next.event_id}; caps packet_items ${limits.items}, packet_words ${limits.words}`,
    held,
    bound: newer(watermark, taken.at(-1)),
  };
}

export async function buildPacket(
  repo: Repo,
  input: PacketInput,
  ctx: PacketContext,
  limits: { items: number; words: number },
): Promise<Packet> {
  return cutPacket(await input(repo, ctx), limits, ctx.watermark);
}
