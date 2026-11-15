import { writeFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { hostTimeZone } from "../core/config/host.ts";
import { EventType } from "../core/domain/ledger.ts";
import { renderLogHtml } from "../core/manifest/html.ts";
import { logHeadings, readLog, type LogDay } from "../core/operate/log.ts";
import type { Repo } from "../core/ports/db.ts";
import { dayOf, validTimeZone } from "../core/usage/rollup.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { CalendarDay } from "./usage-verbs.ts";

export const LogDayJson = z.object({
  host: z.string(),
  day: z.string(),
  time_zone: z.string(),
  since: z.string(),
  until: z.string(),
  headings: z.array(
    z.object({
      heading: z.enum(logHeadings),
      lines: z.array(
        z.object({
          event_id: z.number(),
          type: EventType,
          ts: z.string(),
          run_id: z.string().nullable(),
          text: z.string(),
        }),
      ),
    }),
  ),
});
export type LogDayJson = z.infer<typeof LogDayJson>;

export const LogInput = z.strictObject({
  args: z.tuple([]),
  date: CalendarDay.optional(),
  host: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  json: z.boolean().optional(),
});
type LogInput = z.infer<typeof LogInput>;

export const LogOutput = LogDayJson.extend({
  nextSteps: z.array(z.string()).optional(),
});
type LogOutput = z.infer<typeof LogOutput>;

export function logJson(log: LogDay): LogDayJson {
  return {
    ...log,
    since: log.since.toISOString(),
    until: log.until.toISOString(),
    headings: log.headings.map((group) => ({
      heading: group.heading,
      lines: group.lines.map((line) => ({
        ...line,
        ts: line.ts.toISOString(),
      })),
    })),
  };
}

async function logZone(
  db: Repo,
  host: string,
): Promise<{ zone: string; nextSteps: string[] }> {
  const zone = await hostTimeZone(db, host);
  if (zone === null) return { zone: "UTC", nextSteps: [] };
  if (validTimeZone(zone)) return { zone, nextSteps: [] };
  return {
    zone: "UTC",
    nextSteps: [
      `the host Revision's timezone ${zone} is not a time zone; log days read UTC`,
    ],
  };
}

export async function logVerb(input: LogInput): Promise<LogOutput> {
  const profile = readHostProfile();
  const host = input.host ?? profile.hostId;
  const connection = connect(databaseUrl(profile));
  try {
    const { zone, nextSteps } = await logZone(connection.db, host);
    const day = input.date ?? dayOf(new Date(), zone);
    const result = LogOutput.parse({
      ...logJson(await readLog(connection.db, host, day, zone)),
      ...(nextSteps.length === 0 ? {} : { nextSteps }),
    });
    if (input.html !== undefined)
      writeFileSync(input.html, renderLogHtml(JSON.stringify(result)));
    return result;
  } finally {
    await connection.close();
  }
}

export function renderLog(output: LogOutput): string {
  return [
    `log for ${output.day} (${output.time_zone}), host ${output.host}`,
    ...output.headings.flatMap((group) => [
      `## ${group.heading}`,
      ...(group.lines.length === 0
        ? ["none"]
        : group.lines.map(
            (line) => `- ${line.ts} #${line.event_id} ${line.text}`,
          )),
    ]),
    ...(output.nextSteps ?? []),
  ].join("\n");
}
