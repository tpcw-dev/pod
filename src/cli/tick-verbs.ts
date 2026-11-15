import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { Json } from "../core/domain/json.ts";
import { StepRecord, TriggerSource } from "../core/domain/tick.ts";
import { dryRunTick, runTick } from "../core/operate/tick.ts";
import type { TriggerInput } from "../core/operate/triggers.ts";
import { PodError, exitFor, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { actorOf, writerOf } from "./identity.ts";

export const TickInput = z.strictObject({
  args: z.tuple([]),
  host: z.string().min(1).optional(),
  trigger: z.array(z.string()).optional(),
  "dry-run": z.boolean().optional(),
});
type TickInput = z.infer<typeof TickInput>;

export const TickOutput = z.object({
  host: z.string(),
  outcome: z.enum(["ran", "coalesced", "not due", "dry run"]),
  due: z.boolean().nullable(),
  tick_id: z.string().nullable(),
  event_id: z.number().nullable(),
  replayed: z.boolean(),
  schedule_revision: z.string().nullable(),
  recorded: z.array(
    z.object({
      event_id: z.number(),
      host: z.string(),
      source: TriggerSource,
      trigger_id: z.string(),
      created: z.boolean(),
    }),
  ),
  consumed: z.array(z.number()),
  pending: z.array(z.number()),
  steps: z.array(StepRecord),
  launch: z.array(Json),
  refuse: z.array(Json),
});
type TickOutput = z.infer<typeof TickOutput>;

function parseTrigger(text: string): TriggerInput {
  const at = text.indexOf(":");
  const source = TriggerSource.safeParse(at < 0 ? "" : text.slice(0, at));
  const id = at < 0 ? "" : text.slice(at + 1);
  if (!source.success || id === "")
    throw usageError(
      `usage: tick --trigger ${text} is not SOURCE:ID with SOURCE one of ${TriggerSource.options.join(", ")}`,
      ["pod tick --help"],
    );
  return { source: source.data, trigger_id: id };
}

export function tickOpKeyMeta(output: TickOutput) {
  return output.tick_id === null ? {} : { opKey: output.tick_id };
}

export async function tick(input: TickInput): Promise<TickOutput> {
  const triggers = (input.trigger ?? []).map(parseTrigger);
  const profile = readHostProfile();
  const host = input.host ?? profile.hostId;
  const connection = connect(databaseUrl(profile));
  try {
    const db = connection.db;
    const now = new Date();
    const outcome =
      input["dry-run"] === true
        ? await dryRunTick(db, { host, now, triggers })
        : await runTick(db, {
            host,
            writer: profile.hostId,
            actor: actorOf(await writerOf(db, profile, process.env, null)),
            now,
            triggers,
          });
    if (!outcome.ok) {
      const { refusal } = outcome;
      throw new PodError(
        refusal.code,
        exitFor(refusal.code),
        refusal.message,
        refusal.nextSteps,
      );
    }
    return outcome;
  } finally {
    await connection.close();
  }
}
