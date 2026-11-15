import { Json } from "../domain/json.ts";
import {
  TickPayload,
  TriggerPayload,
  type TriggerSource,
} from "../domain/tick.ts";
import type { Repo } from "../ports/db.ts";

export interface TriggerInput {
  source: TriggerSource;
  trigger_id: string;
}

export interface RecordedTrigger {
  event_id: number;
  host: string;
  source: TriggerSource;
  trigger_id: string;
  created: boolean;
}

export interface TickEvent {
  id: number;
  ts: Date;
  op_key: string | null;
  payload: TickPayload;
}

export async function recordTriggers(
  repo: Repo,
  input: {
    host: string;
    writer: string;
    actor: string;
    now: Date;
    triggers: readonly TriggerInput[];
  },
): Promise<RecordedTrigger[]> {
  const recorded: RecordedTrigger[] = [];
  for (const each of input.triggers) {
    const { event, created } = await repo.recordTrigger({
      type: "trigger",
      ts: input.now,
      host: input.writer,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: null,
      payload: Json.parse({
        host: input.host,
        source: each.source,
        trigger_id: each.trigger_id,
      }),
      source: Json.parse({ kind: "command", verb: "tick", actor: input.actor }),
    });
    const stored = TriggerPayload.parse(event.payload);
    recorded.push({ event_id: event.id, ...stored, created });
  }
  return recorded;
}

export async function tickEvents(
  repo: Repo,
  host: string,
): Promise<TickEvent[]> {
  return (await repo.eventsWith("tick", { host })).flatMap((each) => {
    const parsed = TickPayload.safeParse(each.payload);
    return parsed.success
      ? [
          {
            id: each.id,
            ts: each.ts,
            op_key: each.op_key,
            payload: parsed.data,
          },
        ]
      : [];
  });
}

export function newestTick(ticks: readonly TickEvent[]): TickEvent | null {
  return ticks.reduce<TickEvent | null>(
    (newest, each) => (newest === null || each.id > newest.id ? each : newest),
    null,
  );
}

export async function pendingTriggers(
  repo: Repo,
  host: string,
  ticks: readonly TickEvent[],
): Promise<number[]> {
  const acknowledged = new Set(ticks.flatMap((each) => each.payload.triggers));
  return (await repo.eventsWith("trigger", { host }))
    .filter((each) => TriggerPayload.safeParse(each.payload).success)
    .map((each) => each.id)
    .filter((id) => !acknowledged.has(id))
    .sort((a, b) => a - b);
}
