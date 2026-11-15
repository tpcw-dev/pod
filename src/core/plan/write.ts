import { canonicalJson } from "../config/canonical-json.ts";
import { Json } from "../domain/json.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import { distinct, PlanPayload, type OverrideRequest } from "../domain/plan.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db, Repo } from "../ports/db.ts";
import { dayEnd, isDay } from "./clock.ts";
import { planHost, type PlanHost } from "./host.ts";
import { inForce, newestOf, planEvents, type PlanEvent } from "./overrides.ts";

export interface WriteInput {
  host: string;
  writer: string;
  actor: string;
  now: Date;
}

export interface OverrideInput extends WriteInput {
  request: OverrideRequest;
}

export interface Keyed {
  event_id: number;
  ts: Date;
  op_key: string;
  replayed: boolean;
  payload: PlanPayload;
}

export type Written =
  | ({
      ok: true;
      event_id: number;
      op_key: string;
      replayed: boolean;
    } & PlanPayload)
  | Refused;

interface Append {
  context: PlanHost;
  base: string;
  payload: PlanPayload;
  verb: string;
  writer: string;
  now: Date;
}

function attemptOf(base: string, opKey: string | null): boolean {
  return opKey === base || (opKey?.startsWith(`${base}:`) ?? false);
}

function replay(each: PlanEvent): Keyed {
  return {
    event_id: each.id,
    ts: each.ts,
    op_key: each.op_key ?? "",
    replayed: true,
    payload: each.payload,
  };
}

async function recorded(tx: Repo, host: string, opKey: string) {
  const events = planEvents(await tx.eventsWith("plan", { host }));
  return events.find((each) => each.op_key === opKey);
}

export function opKeyBase(
  context: PlanHost,
  kind: PlanPayload["kind"],
  target: unknown,
): string {
  return derivedOpKey("plan", {
    host: context.host,
    day: context.day,
    kind,
    target: canonicalJson(target),
  });
}

export function replayOf(
  context: PlanHost,
  base: string,
  payload: PlanPayload,
): Keyed | null {
  const newest = newestOf(context.events, familyOf(payload));
  return newest !== undefined && attemptOf(base, newest.op_key)
    ? replay(newest)
    : null;
}

export async function appendKeyed(tx: Repo, write: Append): Promise<Keyed> {
  const { context, base, payload, now } = write;
  for (let attempt = 1; ; attempt += 1) {
    const opKey = attempt === 1 ? base : `${base}:${attempt}`;
    if ((await tx.getOperation(opKey)) !== null) continue;
    const { created } = await tx.insertOperation({
      op_key: opKey,
      intent: "plan",
      owner_generation: 0,
      at: now,
      result_ref: null,
    });
    if (!created) {
      const raced = await recorded(tx, context.host, opKey);
      if (raced !== undefined) return replay(raced);
      continue;
    }
    const appended = await tx.appendEvent({
      type: "plan",
      ts: now,
      host: write.writer,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse(payload),
      source: Json.parse({
        kind: "command",
        verb: write.verb,
        actor: payload.actor,
      }),
    });
    await tx.moveOperation(opKey, "done", { event_id: appended.id }, now);
    return {
      event_id: appended.id,
      ts: now,
      op_key: opKey,
      replayed: false,
      payload,
    };
  }
}

function usage(message: string): Refused {
  return refuse("usage", message, ["pod plan --help"]);
}

function expiry(
  context: PlanHost,
  until: string | null,
): { until: string | null; expires_at: string } | Refused {
  if (until !== null && !isDay(until))
    return usage(`--until ${until} is not a YYYY-MM-DD date`);
  if (until !== null && until < context.day)
    return usage(
      `--until ${until} is before host ${context.host}'s day ${context.day}`,
    );
  return {
    until,
    expires_at: dayEnd(until ?? context.day, context.timezone).toISOString(),
  };
}

function notHeld(host: string, key: string): Refused {
  return refuse("not_held", `${key} has no hold in force on host ${host}`, [
    `pod plan --host ${host} lists the holds in force`,
  ]);
}

function overridePayload(
  context: PlanHost,
  request: OverrideRequest,
  actor: string,
): PlanPayload | Refused {
  const common = { host: context.host, day: context.day, actor };
  if (request.kind === "release")
    return { kind: "release", ...common, key: request.key };
  const expires = expiry(context, request.until);
  if ("ok" in expires) return expires;
  if (request.kind === "hold") {
    if (request.reason.trim() === "") return usage("--reason is empty");
    return {
      kind: "hold",
      ...common,
      ...expires,
      key: request.key,
      reason: request.reason,
      ...(request.project === undefined ? {} : { project: request.project }),
    };
  }
  const list = request.kind === "priority" ? request.projects : request.keys;
  if (!distinct(list))
    return usage(`pod plan ${request.kind} names one entry twice`);
  return request.kind === "priority"
    ? { kind: "priority", ...common, ...expires, projects: request.projects }
    : { kind: "order", ...common, ...expires, keys: request.keys };
}

function isHeld(context: PlanHost, key: string, now: Date): boolean {
  return inForce(context.events, now).holds.some((each) => each.key === key);
}

function familyOf(payload: PlanPayload): (each: PlanEvent) => boolean {
  if (payload.kind === "hold" || payload.kind === "release") {
    const key = payload.key;
    return ({ payload: each }) =>
      (each.kind === "hold" || each.kind === "release") && each.key === key;
  }
  if (payload.kind === "published") {
    const day = payload.day;
    return ({ payload: each }) => each.kind === "published" && each.day === day;
  }
  return ({ payload: each }) => each.kind === payload.kind;
}

function targetOf(request: OverrideRequest): unknown {
  switch (request.kind) {
    case "hold":
      return {
        key: request.key,
        reason: request.reason,
        until: request.until,
        ...(request.project === undefined ? {} : { project: request.project }),
      };
    case "release":
      return { key: request.key };
    case "priority":
      return { projects: request.projects, until: request.until };
    case "order":
      return { keys: request.keys, until: request.until };
  }
}

export function writeOverride(db: Db, input: OverrideInput): Promise<Written> {
  return db.transaction(async (tx) => {
    const context = await planHost(tx, input.host, input.now);
    if (!context.ok) return context;
    const payload = overridePayload(context, input.request, input.actor);
    if ("ok" in payload) return payload;
    const base = opKeyBase(context, payload.kind, targetOf(input.request));
    const replayed = replayOf(context, base, payload);
    if (
      replayed === null &&
      payload.kind === "release" &&
      !isHeld(context, payload.key, input.now)
    )
      return notHeld(context.host, payload.key);
    const keyed =
      replayed ??
      (await appendKeyed(tx, {
        context,
        base,
        payload,
        verb: `plan ${payload.kind}`,
        writer: input.writer,
        now: input.now,
      }));
    return {
      ok: true,
      event_id: keyed.event_id,
      op_key: keyed.op_key,
      replayed: keyed.replayed,
      ...keyed.payload,
    };
  });
}
