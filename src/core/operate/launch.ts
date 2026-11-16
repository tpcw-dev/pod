import { z } from "zod";
import { activeSchedule } from "../config/schedule.ts";
import type { Json } from "../domain/json.ts";
import { planHost } from "../plan/host.ts";
import { inForce, newestPublished } from "../plan/overrides.ts";
import type { Repo } from "../ports/db.ts";
import { recordAttentionDrains } from "../run/attention-pause.ts";
import { launchOpKey, runLaunch } from "../run/launch.ts";
import type { OperatePorts } from "./ports.ts";
import type { StepContext, StepResult } from "./tick.ts";
import { tickEvents } from "./triggers.ts";

/** Host-wide refusals: the loop stops, and the next tick tries again with no hold. */
const stopCodes = new Set(["attention_paused", "quota_exhausted", "config_missing"]);

const Refused = z.looseObject({ story: z.string(), code: z.string() });

async function heldByRefusal(
  repo: Repo,
  host: string,
  now: Date,
): Promise<Set<string>> {
  const holdMinutes = (await activeSchedule(repo, host))?.value.hold_minutes ?? 0;
  const since = now.getTime() - holdMinutes * 60_000;
  const held = new Set<string>();
  for (const tick of await tickEvents(repo, host)) {
    if (tick.ts.getTime() <= since) continue;
    for (const entry of tick.payload.refuse) {
      const refused = Refused.safeParse(entry).data;
      if (refused !== undefined && !stopCodes.has(refused.code))
        held.add(refused.story);
    }
  }
  return held;
}

export async function launchStep(
  ports: OperatePorts,
  ctx: Pick<StepContext, "db" | "host" | "actor" | "now">,
): Promise<StepResult> {
  const { db } = ctx;
  const plan = await planHost(db, ctx.host, ctx.now);
  if (!plan.ok)
    return {
      result: "failed",
      detail: { code: plan.refusal.code, message: plan.refusal.message },
    };
  const drains = await recordAttentionDrains(db, {
    host: ctx.host,
    timezone: plan.timezone,
    actor: ctx.actor,
    now: ctx.now,
  });
  const published = newestPublished(plan.events, plan.day);
  const launch: Json[] = [];
  const refuse: Json[] = [];
  if (published === null)
    return { result: "ok", detail: { drains }, launch, refuse };
  const holds = new Set(
    inForce(plan.events, ctx.now).holds.map((hold) => hold.key),
  );
  const held = await heldByRefusal(db, ctx.host, ctx.now);
  for (const entry of published.ranked) {
    if (holds.has(entry.key) || held.has(entry.key)) continue;
    const subject = String(published.event_id);
    const prior = await db.getOperation(
      launchOpKey(ctx.host, subject, entry.key),
    );
    if (prior !== null && prior.status !== "pending") continue;
    const story = await db.getStory(ports.provider, entry.key);
    if (prior === null && story?.run_id != null) continue;
    const outcome = await runLaunch(
      db,
      { orca: ports.orca, tracker: ports.tracker, log: ports.log },
      {
        story: entry.key,
        host: ctx.host,
        provider: ports.provider,
        seats: {},
        subject,
        coordinator: ctx.actor,
        command: `pod tick --host ${ctx.host}`,
        now: () => ctx.now,
      },
    );
    if (outcome.ok) {
      launch.push({
        story: entry.key,
        run_id: outcome.result.run_id,
        op_key: outcome.result.op_key,
        dispatch_id: outcome.result.dispatch.dispatch_id,
        replayed: outcome.result.replayed,
      });
      continue;
    }
    refuse.push({
      story: entry.key,
      code: outcome.refusal.code,
      message: outcome.refusal.message,
    });
    if (stopCodes.has(outcome.refusal.code)) break;
  }
  return {
    result: "ok",
    detail: { drains, launched: launch.length, refused: refuse.length },
    launch,
    refuse,
  };
}
