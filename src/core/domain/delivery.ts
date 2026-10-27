import { z } from "zod";
import type { OrcaMessage } from "../ports/orca.ts";

const Settling = z.literal("worker_done");
const Waiting = z.enum(["escalation", "question", "decision_gate"]);
const AckedOnly = z.enum([
  "heartbeat",
  "status",
  "merge_ready",
  "handoff",
  "dispatch",
]);
const WorkerOutcome = z.enum(["succeeded", "failed"]);

export type IgnoredReason =
  "no_dispatch" | "unknown_dispatch" | "settled_dispatch";

export type DeliveryRow =
  | { kind: "ignored"; reason: IgnoredReason }
  | { kind: "none" }
  | {
      kind: "delivery";
      outcome: "done" | "failed" | "waiting";
      activity: "settled" | "waiting";
      settlement: "done" | "failed" | "open";
    }
  | { kind: "delivery"; outcome: "unknown" };

export interface DeliveryMatch {
  settlement: string;
  latest: boolean;
}

export function deliveryOutcome(
  message: OrcaMessage,
  match: DeliveryMatch | null,
): DeliveryRow {
  if (message.payload.dispatchId === undefined)
    return { kind: "ignored", reason: "no_dispatch" };
  if (match === null) return { kind: "ignored", reason: "unknown_dispatch" };
  if (match.settlement !== "open" || !match.latest)
    return { kind: "ignored", reason: "settled_dispatch" };
  if (AckedOnly.safeParse(message.type).success) return { kind: "none" };
  if (Waiting.safeParse(message.type).success)
    return {
      kind: "delivery",
      outcome: "waiting",
      activity: "waiting",
      settlement: "open",
    };
  const outcome = WorkerOutcome.safeParse(message.payload.outcome);
  if (Settling.safeParse(message.type).success && outcome.success) {
    const settled = outcome.data === "succeeded" ? "done" : "failed";
    return {
      kind: "delivery",
      outcome: settled,
      activity: "settled",
      settlement: settled,
    };
  }
  return { kind: "delivery", outcome: "unknown" };
}
