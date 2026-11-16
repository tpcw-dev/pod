import { z } from "zod";
import { Json } from "../domain/json.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import { hostDay } from "../plan/clock.ts";
import type { Db } from "../ports/db.ts";
import { endHostPause, hostsInForce } from "../run/attention-pause.ts";
import { agendaHash, sectionNames, type AgendaSection } from "./agenda.ts";

export const StandupOutcome = z.enum(["done", "skipped"]);
export type StandupOutcome = z.infer<typeof StandupOutcome>;

export const SectionResult = z.object({
  name: z.enum(sectionNames),
  result: z.enum(["clear", "open", "unknown", "not_reached"]),
  open: z.array(z.string()),
});
export type SectionResult = z.infer<typeof SectionResult>;

export const StandupPayload = z.object({
  day: z.string(),
  outcome: StandupOutcome,
  reason: z.string().nullable(),
  agenda_hash: z.string(),
  sections: z.array(SectionResult),
  ended: z.array(z.string()),
});
export type StandupPayload = z.infer<typeof StandupPayload>;

export const StandupResult = StandupPayload.extend({
  op_key: z.string(),
  recorded: z.boolean(),
  nextSteps: z.array(z.string()),
});
export type StandupResult = z.infer<typeof StandupResult>;

export interface StandupInput {
  host: string;
  timezone: string;
  actor: string;
  outcome: StandupOutcome;
  reason: string | null;
  agenda: readonly AgendaSection[];
  now: Date;
}

function resultsOf(
  agenda: readonly AgendaSection[],
  outcome: StandupOutcome,
): SectionResult[] {
  return agenda.map((section) => {
    if (outcome === "skipped")
      return { name: section.name, result: "not_reached", open: [] };
    if (section.state === "open")
      return { name: section.name, result: "open", open: section.items };
    return {
      name: section.name,
      result: section.state === "none" ? "clear" : "unknown",
      open: [],
    };
  });
}

function openSteps(sections: readonly SectionResult[]): string[] {
  return sections
    .filter((section) => section.result === "open")
    .map(
      (section) =>
        `${section.name} has ${section.open.length} open item${section.open.length === 1 ? "" : "s"}`,
    );
}

export async function recordStandup(
  db: Db,
  input: StandupInput,
): Promise<StandupResult> {
  if (!input.actor.startsWith("person:"))
    throw new Error(`${input.actor} is not a person; a standup needs a person`);
  if (input.outcome === "skipped" && !input.reason)
    throw new Error("a skipped standup needs a reason");
  const day = hostDay(input.now, input.timezone);
  const opKey = derivedOpKey("standup", { day, outcome: input.outcome });
  const verb = `standup ${input.outcome === "done" ? "done" : "skip"}`;
  return db.transaction(async (tx) => {
    const ended = await hostsInForce(tx);
    const sections = resultsOf(input.agenda, input.outcome);
    const payload: StandupPayload = {
      day,
      outcome: input.outcome,
      reason: input.outcome === "skipped" ? input.reason : null,
      agenda_hash: agendaHash(input.agenda),
      sections,
      ended,
    };
    const stored = await tx.claimStandupDay({
      type: "standup",
      ts: input.now,
      host: input.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse(payload),
      source: { kind: "command", verb, actor: input.actor },
    });
    if (!stored.created) {
      const prior = StandupPayload.parse(stored.event.payload);
      return {
        ...prior,
        op_key: derivedOpKey("standup", {
          day: prior.day,
          outcome: prior.outcome,
        }),
        recorded: false,
        nextSteps: [
          `the standup of ${day} is already recorded as ${prior.outcome}`,
          ...openSteps(prior.sections),
        ],
      };
    }
    const request = { day, outcome: input.outcome };
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "standup",
      owner_generation: 0,
      at: input.now,
      result_ref: { request },
    });
    if (!inserted.created)
      throw new Error(`op key ${opKey} is stored with no standup event`);
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, result: payload }),
      input.now,
    );
    for (const host of ended)
      await endHostPause(tx, {
        host,
        actor: input.actor,
        verb,
        opKey: derivedOpKey("drain", {
          host,
          scope: "host",
          ended: "true",
          standup: opKey,
        }),
        now: input.now,
      });
    return {
      ...payload,
      op_key: opKey,
      recorded: true,
      nextSteps: openSteps(sections),
    };
  });
}
