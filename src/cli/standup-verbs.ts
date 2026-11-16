import { writeFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { escapeHtml } from "../core/manifest/html.ts";
import { planHost } from "../core/plan/host.ts";
import type { Db } from "../core/ports/db.ts";
import { AgendaSection, agendaHash, agendaOf } from "../core/standup/agenda.ts";
import {
  recordStandup,
  StandupResult,
  type StandupOutcome,
} from "../core/standup/record.ts";
import { brief } from "./brief.ts";
import { exitFor, PodError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { actorOf, needsPerson, writerOf } from "./identity.ts";

export const StandupInput = z.strictObject({
  args: z.tuple([]),
  project: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
});
type StandupInput = z.infer<typeof StandupInput>;

export const StandupOutput = z.object({
  day: z.string(),
  agenda_hash: z.string(),
  sections: z.array(AgendaSection),
  nextSteps: z.array(z.string()).optional(),
});
type StandupOutput = z.infer<typeof StandupOutput>;

export const StandupDoneInput = z.strictObject({ args: z.tuple([]) });

export const StandupSkipInput = z.strictObject({
  args: z.tuple([]),
  reason: z.string().min(1),
});
type StandupSkipInput = z.infer<typeof StandupSkipInput>;

function sitting(command: string) {
  return {
    what: "recording the standup",
    nextSteps: [`Run ${command} from the operator's shell`],
  };
}

async function hostTimezone(
  db: Db,
  host: string,
  now: Date,
): Promise<{ day: string; timezone: string }> {
  const plan = await planHost(db, host, now);
  if (!plan.ok)
    throw new PodError(
      plan.refusal.code,
      exitFor(plan.refusal.code),
      plan.refusal.message,
      plan.refusal.nextSteps,
    );
  return { day: plan.day, timezone: plan.timezone };
}

export async function standup(input: StandupInput): Promise<StandupOutput> {
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const { day } = await hostTimezone(connection.db, host.hostId, new Date());
    const read = await brief({
      args: [],
      ...(input.project === undefined ? {} : { project: input.project }),
    });
    const sections = agendaOf(read);
    const result: StandupOutput = {
      day,
      agenda_hash: agendaHash(sections),
      sections,
      ...(read.nextSteps === undefined ? {} : { nextSteps: read.nextSteps }),
    };
    if (input.html !== undefined)
      writeFileSync(
        input.html,
        `<!doctype html><meta charset="utf-8"><title>Standup ${day}</title><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>\n`,
      );
    return result;
  } finally {
    await connection.close();
  }
}

async function record(
  outcome: StandupOutcome,
  reason: string | null,
): Promise<StandupResult> {
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const need = sitting(
      outcome === "done"
        ? "pod standup done"
        : "pod standup skip --reason TEXT",
    );
    const identity = await writerOf(connection.db, host, process.env, need);
    needsPerson(identity, need);
    const now = new Date();
    const { timezone } = await hostTimezone(connection.db, host.hostId, now);
    const read = await brief({ args: [] });
    return await recordStandup(connection.db, {
      host: host.hostId,
      timezone,
      actor: actorOf(identity),
      outcome,
      reason,
      agenda: agendaOf(read),
      now,
    });
  } finally {
    await connection.close();
  }
}

export function standupDone(): Promise<StandupResult> {
  return record("done", null);
}

export function standupSkip(input: StandupSkipInput): Promise<StandupResult> {
  return record("skipped", input.reason);
}

export function standupMeta(output: StandupResult) {
  return { opKey: output.op_key };
}
