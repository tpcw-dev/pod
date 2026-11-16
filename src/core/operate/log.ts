import type { Json } from "../domain/json.ts";
import type { Event, EventType } from "../domain/ledger.ts";
import {
  MetaTickPayload,
  TickPayload,
  type MetaStepOutcome,
  type StepOutcome,
} from "../domain/tick.ts";
import type { Repo } from "../ports/db.ts";
import { dayWindow } from "../usage/rollup.ts";

export const logHeadings = [
  "Launched",
  "Closed",
  "Groomed",
  "Decided",
  "Needs a person",
  "Held",
  "Skipped",
  "Errors",
] as const;
export type LogHeading = (typeof logHeadings)[number];

export interface LogLine {
  event_id: number;
  type: EventType;
  ts: Date;
  run_id: string | null;
  text: string;
}

export interface LogGroup {
  heading: LogHeading;
  lines: LogLine[];
}

export interface LogDay {
  host: string;
  day: string;
  time_zone: string;
  since: Date;
  until: Date;
  headings: LogGroup[];
}

type Entry = [LogHeading, string];

const LINE_LIMIT = 160;
const shownFields = [
  "story",
  "seat",
  "role",
  "step",
  "kind",
  "key",
  "outcome",
  "reason",
  "text",
  "decision_id",
] as const;

function record(payload: Json): Record<string, Json> | null {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? payload
    : null;
}

function cut(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, LINE_LIMIT);
}

function described(event: Event, fields: Record<string, Json>): string {
  const parts: string[] = [event.type];
  if (event.run_id !== null) parts.push(`run ${event.run_id}`);
  for (const field of shownFields) {
    const value = fields[field];
    if (typeof value === "string") parts.push(`${field}=${value}`);
  }
  return cut(parts.join(" "));
}

function unreadable(event: Event): Entry[] {
  return [["Errors", `${event.type} payload unreadable`]];
}

type Place = (event: Event) => Entry[];

function under(heading: LogHeading): Place {
  return (event) => {
    const fields = record(event.payload);
    return fields === null
      ? unreadable(event)
      : [[heading, described(event, fields)]];
  };
}

function plan(event: Event): Entry[] {
  const kind = record(event.payload)?.["kind"];
  return under(kind === "hold" ? "Held" : "Decided")(event);
}

const stepHeadings: Partial<Record<StepOutcome | MetaStepOutcome, LogHeading>> =
  {
    failed: "Errors",
    timed_out: "Errors",
    skipped: "Skipped",
  };

function stepLines(
  steps: readonly {
    step: string;
    result: StepOutcome | MetaStepOutcome;
    detail: Json;
  }[],
): Entry[] {
  return steps.flatMap((step): Entry[] => {
    const heading = stepHeadings[step.result];
    if (heading === undefined) return [];
    const detail =
      step.detail === null ? "" : ` ${JSON.stringify(step.detail)}`;
    return [[heading, cut(`tick step ${step.step} ${step.result}${detail}`)]];
  });
}

function tick(event: Event): Entry[] {
  const meta = MetaTickPayload.safeParse(event.payload);
  if (meta.success) return stepLines(meta.data.steps);
  const parsed = TickPayload.safeParse(event.payload);
  if (!parsed.success) return unreadable(event);
  const refused = parsed.data.refuse.map((entry): Entry => [
    "Skipped",
    cut(`tick refuse ${JSON.stringify(entry)}`),
  ]);
  return [...stepLines(parsed.data.steps), ...refused];
}

const quiet: Place = () => [];

/** Groomed has no event type yet; adding one to eventTypes forces its row here. */
const placement: Record<EventType, Place> = {
  start: under("Launched"),
  retry: under("Launched"),
  close: under("Closed"),
  decision: under("Decided"),
  self_decision: under("Decided"),
  ruling: under("Decided"),
  plan,
  escalate: under("Needs a person"),
  activation_requested: under("Needs a person"),
  hold: under("Held"),
  drain: under("Held"),
  stop: under("Held"),
  cancel: under("Held"),
  ignored: under("Skipped"),
  unknown_launch: under("Errors"),
  tick,
  delivery: quiet,
  receipt: quiet,
  activation: quiet,
  push: quiet,
  pr: quiet,
  deploy: quiet,
  release: quiet,
  takeover: quiet,
  resume: quiet,
  learning: quiet,
  outcome: quiet,
  retro: quiet,
  digest: quiet,
  trigger: quiet,
};

function hostOf(event: Event): string {
  const host = record(event.payload)?.["host"];
  return typeof host === "string" ? host : event.host;
}

export function groupLog(events: readonly Event[], host: string): LogGroup[] {
  const groups = logHeadings.map((heading) => ({
    heading,
    lines: [] as LogLine[],
  }));
  for (const event of events) {
    if (hostOf(event) !== host) continue;
    for (const [heading, text] of placement[event.type](event))
      groups[logHeadings.indexOf(heading)]?.lines.push({
        event_id: event.id,
        type: event.type,
        ts: event.ts,
        run_id: event.run_id,
        text,
      });
  }
  return groups;
}

export async function readLog(
  repo: Repo,
  host: string,
  day: string,
  timeZone: string,
): Promise<LogDay> {
  const { since, until } = dayWindow(day, timeZone);
  return {
    host,
    day,
    time_zone: timeZone,
    since,
    until,
    headings: groupLog(await repo.eventsBetween(since, until), host),
  };
}
