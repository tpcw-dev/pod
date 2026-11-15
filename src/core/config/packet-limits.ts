import { z } from "zod";
import type { Repo } from "../ports/db.ts";
import { singleActive } from "./active.ts";

export const packetLimitBounds = {
  packet_items: { min: 1, max: 100 },
  packet_words: { min: 500, max: 8000 },
  packet_minutes: { min: 5, max: 120 },
} as const;

export type PacketLimitName = keyof typeof packetLimitBounds;

export function packetLimit(name: PacketLimitName) {
  const { min, max } = packetLimitBounds[name];
  return z.int().min(min).max(max);
}

const PolicyLimits = z.looseObject({
  limits: z.looseObject({
    packet_items: packetLimit("packet_items"),
    packet_words: packetLimit("packet_words"),
    packet_minutes: packetLimit("packet_minutes"),
  }),
});

export interface PacketLimits {
  items: number;
  words: number;
  minutes: number;
}

export async function packetLimits(repo: Repo): Promise<PacketLimits | null> {
  const policy = await singleActive(repo, "policy", "global", "");
  const limits = PolicyLimits.safeParse(policy?.value).data?.limits;
  return limits === undefined
    ? null
    : {
        items: limits.packet_items,
        words: limits.packet_words,
        minutes: limits.packet_minutes,
      };
}
