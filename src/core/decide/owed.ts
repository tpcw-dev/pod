import { z } from "zod";
import { Json } from "../domain/json.ts";
import { decisionSendOpKey } from "../dispatch/decision-seats.ts";
import type { Repo } from "../ports/db.ts";

export const FollowUp = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposal"),
    decision_id: z.string(),
    round: z.int(),
    proposal: z.string(),
    citations: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("round_next"),
    decision_id: z.string(),
    round: z.int(),
    to: z.string(),
    audit: z.string(),
    points_of_disagreement: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("evidence_request"),
    decision_id: z.string(),
    round: z.int(),
    to: z.string(),
    audit: z.string(),
  }),
  z.object({
    kind: z.literal("round_evidence"),
    decision_id: z.string(),
    round: z.int(),
    proposal: z.string(),
    citations: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("resume"),
    decision_id: z.string(),
    round: z.int(),
    relaunch: z.int(),
  }),
]);
export type FollowUp = z.infer<typeof FollowUp>;

export const OwedSend = z.looseObject({
  kind: z.literal("decision_send"),
  request: z.looseObject({ run_id: z.string(), decision_id: z.string() }),
  follow_up: FollowUp,
});
export type OwedSend = z.infer<typeof OwedSend>;

export async function oweSend(
  tx: Repo,
  input: {
    runId: string;
    generation: number;
    followUp: FollowUp;
    attempt: number;
    at: Date;
  },
): Promise<void> {
  const { followUp } = input;
  const ref: OwedSend = {
    kind: "decision_send",
    request: { run_id: input.runId, decision_id: followUp.decision_id },
    follow_up: followUp,
  };
  await tx.insertOperation({
    op_key: decisionSendOpKey({
      send: followUp.kind,
      decision_id: followUp.decision_id,
      round: followUp.round,
      attempt: input.attempt,
    }),
    intent: "decide",
    owner_generation: input.generation,
    at: input.at,
    result_ref: Json.parse(ref),
  });
}
