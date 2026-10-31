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

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Text = z.string().min(1);
const Pr = z.strictObject({ number: z.int(), url: Text, head: Sha });
const Deploy = z.strictObject({
  environment: Text,
  deployment_id: Text,
  deployed_revision: Text,
  source_commit: Text,
});

type FactType = "push" | "pr" | "deploy";

interface DeliveryFacts {
  facts: { type: FactType; fields: Record<string, string | number> }[];
  ignored: string[];
}

export function deliveryFacts(message: OrcaMessage): DeliveryFacts {
  const found: DeliveryFacts = { facts: [], ignored: [] };
  const payload: Record<string, unknown> = message.payload;
  const read = <T extends Record<string, string | number>>(
    field: string,
    type: FactType,
    schema: z.ZodType<T>,
  ) => {
    if (!(field in payload)) return;
    const parsed = schema.safeParse(payload[field]);
    if (parsed.success) found.facts.push({ type, fields: parsed.data });
    else
      found.ignored.push(
        `ignored ${field} on message ${message.id}: ${parsed.error.issues[0]?.message ?? "malformed"}`,
      );
  };
  read(
    "head",
    "push",
    Sha.transform((sha) => ({ sha })),
  );
  read("pr", "pr", Pr);
  read("deploy", "deploy", Deploy);
  return found;
}
