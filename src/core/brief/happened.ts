import { z } from "zod";
import { yesterdayOf } from "../domain/brief.ts";
import { GateReceiptPayload, type Event } from "../domain/ledger.ts";
import { NeedsHumanLine, TickPayload } from "../domain/tick.ts";
import { hostDay, wallInstant } from "../plan/clock.ts";
import type { Repo } from "../ports/db.ts";

const Fact = z.object({
  event_id: z.number(),
  ts: z.string(),
  run_id: z.string().nullable(),
});

export const BriefSitting = z.object({
  window: z.object({ since: z.string(), until: z.string() }),
  happened: z.object({
    closed_runs: z.array(Fact.extend({ story: z.string().nullable() })),
    prs: z.array(
      Fact.extend({
        number: z.number().nullable(),
        url: z.string().nullable(),
      }),
    ),
    deploys: z.array(
      Fact.extend({
        environment: z.string().nullable(),
        deployed_revision: z.string().nullable(),
      }),
    ),
    gates: z.array(
      Fact.extend({ gate: z.string(), outcome: z.enum(["PASS", "FAIL"]) }),
    ),
    stops: z.array(
      Fact.extend({
        type: z.enum(["hold", "escalate"]),
        text: z.string().nullable(),
      }),
    ),
    ticks: z.array(
      Fact.extend({
        host: z.string(),
        tick_id: z.string(),
        result: z.enum(["ok", "failed"]),
        needs_human: z.array(NeedsHumanLine),
      }),
    ),
    velocity: z.literal("unknown"),
    tokens_per_point: z.literal("unknown"),
    minutes_per_point: z.literal("unknown"),
  }),
});
export type Happened = z.infer<typeof BriefSitting>["happened"];

const Fields = z.record(z.string(), z.unknown());

function text(payload: unknown, field: string): string | null {
  const value = Fields.safeParse(payload).data?.[field];
  return typeof value === "string" ? value : null;
}

function count(payload: unknown, field: string): number | null {
  const value = Fields.safeParse(payload).data?.[field];
  return typeof value === "number" ? value : null;
}

export function windowSince(input: {
  standup: Date | null;
  pauseAt: string | null;
  now: Date;
  zone: string;
}): Date {
  if (input.standup !== null) return input.standup;
  const yesterday = yesterdayOf(hostDay(input.now, input.zone));
  return wallInstant(yesterday, input.pauseAt ?? "00:00", input.zone);
}

export function happenedOf(
  events: readonly Event[],
  stories: ReadonlyMap<string, string>,
): Happened {
  const happened: Happened = {
    closed_runs: [],
    prs: [],
    deploys: [],
    gates: [],
    stops: [],
    ticks: [],
    velocity: "unknown",
    tokens_per_point: "unknown",
    minutes_per_point: "unknown",
  };
  for (const event of events) {
    const fact = {
      event_id: event.id,
      ts: event.ts.toISOString(),
      run_id: event.run_id,
    };
    const { payload } = event;
    switch (event.type) {
      case "close":
        happened.closed_runs.push({
          ...fact,
          story:
            event.run_id === null ? null : (stories.get(event.run_id) ?? null),
        });
        break;
      case "pr":
        happened.prs.push({
          ...fact,
          number: count(payload, "number"),
          url: text(payload, "url"),
        });
        break;
      case "deploy":
        happened.deploys.push({
          ...fact,
          environment: text(payload, "environment"),
          deployed_revision: text(payload, "deployed_revision"),
        });
        break;
      case "receipt": {
        const receipt = GateReceiptPayload.safeParse(payload);
        if (receipt.success)
          happened.gates.push({
            ...fact,
            gate: receipt.data.gate,
            outcome: receipt.data.outcome,
          });
        break;
      }
      case "hold":
        happened.stops.push({
          ...fact,
          type: "hold",
          text: text(payload, "reason"),
        });
        break;
      case "escalate":
        happened.stops.push({
          ...fact,
          type: "escalate",
          text: text(payload, "text"),
        });
        break;
      case "tick": {
        const tick = TickPayload.safeParse(payload);
        if (tick.success)
          happened.ticks.push({
            ...fact,
            host: tick.data.host,
            tick_id: tick.data.tick_id,
            result: tick.data.steps.some((step) => step.result === "failed")
              ? "failed"
              : "ok",
            needs_human: tick.data.needs_human,
          });
        break;
      }
      default:
        break;
    }
  }
  return happened;
}

export async function readHappened(
  repo: Repo,
  since: Date,
  until: Date,
): Promise<Happened> {
  const events = await repo.eventsBetween(since, until);
  const stories = new Map<string, string>();
  for (const event of events)
    if (event.type === "close" && event.run_id !== null) {
      const run = await repo.getRun(event.run_id);
      if (run !== null) stories.set(run.run_id, run.story_external_id);
    }
  return happenedOf(events, stories);
}
