import { z } from "zod";
import { singleActive } from "../config/active.ts";
import { attentionOf } from "../config/limits.ts";
import type { EventType } from "../domain/ledger.ts";
import type { Refusal } from "../domain/outcome.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import { hostDay, hostTime } from "../plan/clock.ts";
import type { Db, Repo } from "../ports/db.ts";

export type AttentionCause = "pause_at" | "unattended";

export interface DueCause {
  cause: AttentionCause;
  op_key: string;
}

/** Event types whose newest event after an open host drain ends the pause. */
export const goEventTypes: readonly EventType[] = ["drain"];

const HostDrain = z.looseObject({ ended: z.boolean() });

function hostDrainKey(
  host: string,
  cause: AttentionCause,
  mark: Record<string, string>,
): string {
  return derivedOpKey("drain", { host, scope: "host", cause, ...mark });
}

export async function dueCauses(
  repo: Repo,
  host: string,
  timezone: string,
  now: Date,
): Promise<DueCause[]> {
  const policy = await singleActive(repo, "policy", "global", "");
  const attention = attentionOf(policy?.value);
  if (attention === null) return [];
  const due: DueCause[] = [];
  if (hostTime(now, timezone) >= attention.pause_at)
    due.push({
      cause: "pause_at",
      op_key: hostDrainKey(host, "pause_at", { day: hostDay(now, timezone) }),
    });
  const person = await repo.newestPersonEvent(host);
  const limit = attention.max_unattended_hours * 3_600_000;
  if (person === null || now.getTime() - person.ts.getTime() > limit)
    due.push({
      cause: "unattended",
      op_key: hostDrainKey(host, "unattended", {
        since: person === null ? "none" : String(person.id),
      }),
    });
  return due;
}

async function inForce(repo: Repo, host: string): Promise<boolean> {
  const open = await repo.latestHostEvent(host, "drain", { scope: "host" });
  if (open === null || HostDrain.safeParse(open.payload).data?.ended !== false)
    return false;
  for (const type of goEventTypes) {
    const go = await repo.latestHostEvent(
      host,
      type,
      type === "drain" ? { scope: "host", ended: true } : {},
    );
    if (go !== null && go.id > open.id) return false;
  }
  return true;
}

export async function attentionPaused(
  repo: Repo,
  host: string,
  timezone: string,
  now: Date,
): Promise<Refusal | null> {
  const unrecorded: AttentionCause[] = [];
  for (const due of await dueCauses(repo, host, timezone, now))
    if ((await repo.getOperation(due.op_key)) === null)
      unrecorded.push(due.cause);
  if (!(await inForce(repo, host)) && unrecorded.length === 0) return null;
  return {
    code: "attention_paused",
    message: `launches on host ${host} are paused until a person runs pod drain --end`,
    nextSteps: [
      ...unrecorded.map((cause) => `attention cause ${cause} is due`),
      "a person runs pod drain --end",
    ],
  };
}

export async function recordAttentionDrains(
  db: Db,
  input: { host: string; timezone: string; actor: string; now: Date },
): Promise<string[]> {
  const recorded: string[] = [];
  for (const due of await dueCauses(db, input.host, input.timezone, input.now))
    await db.transaction(async (tx) => {
      const request = { scope: "host", host: input.host, cause: due.cause };
      const inserted = await tx.insertOperation({
        op_key: due.op_key,
        intent: "drain",
        owner_generation: 0,
        at: input.now,
        result_ref: { request },
      });
      if (!inserted.created) return;
      await tx.moveOperation(due.op_key, "done", { request }, input.now);
      await tx.appendEvent({
        type: "drain",
        ts: input.now,
        host: input.host,
        run_id: null,
        task_id: null,
        dispatch_id: null,
        op_key: due.op_key,
        payload: {
          ended: false,
          op_key: due.op_key,
          scope: "host",
          host: input.host,
          cause: due.cause,
        },
        source: { kind: "tick", actor: input.actor },
      });
      recorded.push(due.op_key);
    });
  return recorded;
}

export const HostDrainResult = z.object({
  scope: z.literal("host"),
  host: z.string(),
  ended: z.literal(true),
  drain_in_force: z.boolean(),
  actor: z.string(),
});
export type HostDrainResult = z.infer<typeof HostDrainResult>;

export async function endHostDrain(
  db: Db,
  input: { host: string; actor: string; now: Date },
): Promise<{ result: HostDrainResult; opKey: string }> {
  const opKey = derivedOpKey("drain", {
    host: input.host,
    scope: "host",
    ended: "true",
    at: input.now.toISOString(),
  });
  const request = { scope: "host", host: input.host, ended: true };
  return db.transaction(async (tx) => {
    const wasInForce = await inForce(tx, input.host);
    await tx.insertOperation({
      op_key: opKey,
      intent: "drain",
      owner_generation: 0,
      at: input.now,
      result_ref: { request },
    });
    await tx.moveOperation(opKey, "done", { request }, input.now);
    await tx.appendEvent({
      type: "drain",
      ts: input.now,
      host: input.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: { ended: true, op_key: opKey, scope: "host", host: input.host },
      source: { kind: "command", verb: "drain", actor: input.actor },
    });
    return {
      opKey,
      result: {
        scope: "host",
        host: input.host,
        ended: true,
        drain_in_force: wasInForce,
        actor: input.actor,
      },
    };
  });
}
