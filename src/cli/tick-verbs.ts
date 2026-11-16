import { z } from "zod";
import { Json } from "../core/domain/json.ts";
import {
  MetaStepRecord,
  NeedsHumanLine,
  StepRecord,
  TriggerSource,
} from "../core/domain/tick.ts";
import { dryRunMeta, metaStepsWith, runMeta } from "../core/operate/meta.ts";
import { unbuiltSeat } from "../core/operate/meta-digest.ts";
import { dryRunTick, operateSteps, runTick } from "../core/operate/tick.ts";
import type { TriggerInput } from "../core/operate/triggers.ts";
import { codeHostFor } from "./code-host.ts";
import { usageError } from "./errors.ts";
import { gitStatus, realGit, worktreeStatus } from "./git.ts";
import { actorOf, writerOf } from "./identity.ts";
import { launchLease, withOrca } from "./run-verbs.ts";

export const TickInput = z.strictObject({
  args: z.tuple([]),
  agenda: z.enum(["operate", "meta"]).optional(),
  host: z.string().min(1).optional(),
  slot: z.string().min(1).optional(),
  trigger: z.array(z.string()).optional(),
  "dry-run": z.boolean().optional(),
});
type TickInput = z.infer<typeof TickInput>;

const OperateTickOutput = z.object({
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
  needs_human: z.array(NeedsHumanLine),
});

const MetaTickOutput = z.object({
  host: z.string(),
  agenda: z.literal("meta"),
  outcome: z.enum(["ran", "coalesced", "not due", "dry run"]),
  schedule_revision: z.string().nullable(),
  slots: z.array(
    z.object({
      slot: z.string(),
      due: z.boolean(),
      tick_id: z.string().nullable(),
      event_id: z.number().nullable(),
      replayed: z.boolean(),
      steps: z.array(MetaStepRecord),
    }),
  ),
});

export const TickOutput = z.union([OperateTickOutput, MetaTickOutput]);
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
  const tickId =
    "slots" in output
      ? (output.slots.find((each) => each.event_id !== null)?.tick_id ?? null)
      : output.tick_id;
  return tickId === null ? {} : { opKey: tickId };
}

function checkAgenda(input: TickInput): void {
  if (input.agenda === "meta") {
    if (input.trigger !== undefined)
      throw usageError(
        "usage: tick --agenda meta takes no --trigger; the meta agenda runs its due slots",
        ["pod tick --agenda meta [--host H] [--slot NAME] [--dry-run]"],
      );
    return;
  }
  if (input.slot !== undefined)
    throw usageError("usage: tick --slot needs --agenda meta", [
      "pod tick --agenda meta --slot NAME",
    ]);
}

export async function tick(input: TickInput): Promise<TickOutput> {
  checkAgenda(input);
  const triggers = (input.trigger ?? []).map(parseTrigger);
  const leaseSeconds = launchLease();
  return withOrca<TickOutput & { ok: true }>(
    async ({ db, orca, tracker, log, host: profile, kinds }) => {
      const host = input.host ?? profile.hostId;
      const now = new Date();
      const slot = input.slot === undefined ? {} : { slot: input.slot };
      const steps = operateSteps({
        orca,
        tracker,
        log,
        codeHost: codeHostFor(),
        git: realGit,
        worktreeStatus,
        gitStatus,
        provider: kinds.trackerKind,
        leaseSeconds,
      });
      const meta = metaStepsWith({
        orca,
        log,
        codeHost: codeHostFor(),
        seat: unbuiltSeat,
      });
      if (input["dry-run"] === true)
        return input.agenda === "meta"
          ? dryRunMeta(db, { host, now, ...slot }, meta)
          : dryRunTick(db, { host, now, triggers }, steps);
      const writer = {
        host,
        writer: profile.hostId,
        actor: actorOf(await writerOf(db, profile, process.env, null)),
        now,
      };
      if (input.agenda === "meta")
        return runMeta(db, { ...writer, ...slot }, meta);
      return runTick(db, { ...writer, triggers }, steps);
    },
  );
}
