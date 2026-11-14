import type { Dispatch } from "../domain/ledger.ts";
import { pointsOf } from "../domain/points.ts";
import type { UsageRecord } from "../domain/usage.ts";
import type { Repo } from "../ports/db.ts";
import { closeStepKey } from "../run/close-record.ts";
import { usageCost } from "./cost.ts";
import { dispatchMinutes } from "./minutes.ts";
import type {
  DoneRun,
  PricedRecord,
  RunFact,
  SeatFact,
  UsageFacts,
  UsageView,
} from "./rollup.ts";

async function seatFacts(
  db: Repo,
  dispatches: readonly Dispatch[],
): Promise<SeatFact[]> {
  const seats: SeatFact[] = [];
  for (const dispatch of dispatches)
    seats.push({
      dispatch,
      minutes: dispatchMinutes(
        dispatch,
        await db.listDispatchActivity(dispatch.dispatch_id),
      ),
    });
  return seats;
}

async function priced(
  db: Repo,
  records: readonly UsageRecord[],
): Promise<PricedRecord[]> {
  const rows: PricedRecord[] = [];
  for (const record of records)
    rows.push({ record, price: await usageCost(db, record) });
  return rows;
}

async function runFact(
  db: Repo,
  runId: string,
  scale: string,
): Promise<RunFact> {
  const run = await db.getRun(runId);
  if (run === null) throw new Error(`Run ${runId} is missing`);
  const snapshot = await db.getSnapshot(runId);
  const story = await db.getStory(run.story_provider, run.story_external_id);
  return {
    run_id: runId,
    project: snapshot?.project ?? null,
    size: story?.size ?? null,
    points: story === null ? null : pointsOf(story.size, scale),
  };
}

export async function runLifetime(
  db: Repo,
  runId: string,
): Promise<{ seats: SeatFact[]; records: PricedRecord[] }> {
  return {
    seats: await seatFacts(db, await db.listDispatches(runId)),
    records: await priced(db, await db.listRunUsageRecords(runId)),
  };
}

async function doneRun(
  db: Repo,
  runId: string,
  doneAt: Date,
): Promise<DoneRun> {
  return { run_id: runId, done_at: doneAt, ...(await runLifetime(db, runId)) };
}

async function dayFacts(
  db: Repo,
  window: { from: Date; to: Date },
): Promise<Pick<UsageFacts, "seats" | "records" | "done">> {
  const seats = await seatFacts(db, await db.listSettledDispatches(window));
  const locator = await db.listDispatchUsageRecords(
    seats.map((seat) => seat.dispatch.dispatch_id),
  );
  const done: DoneRun[] = [];
  for (const row of await db.listRunsDone(window))
    done.push(await doneRun(db, row.run_id, row.done_at));
  return {
    seats,
    records: await priced(db, [
      ...locator,
      ...(await db.listUsageRecords(window)),
    ]),
    done,
  };
}

async function runViewFacts(
  db: Repo,
  runId: string,
): Promise<Pick<UsageFacts, "seats" | "records" | "done">> {
  const lifetime = await runLifetime(db, runId);
  const close = await db.getOperation(closeStepKey(runId, "done"));
  return {
    ...lifetime,
    done:
      close?.status === "done"
        ? [{ run_id: runId, done_at: close.updated_at, ...lifetime }]
        : [],
  };
}

export async function usageFacts(
  db: Repo,
  view: UsageView,
  timeZone: string,
  scale: string,
): Promise<UsageFacts> {
  const rows =
    view.kind === "day"
      ? await dayFacts(db, { from: view.since, to: view.until })
      : (await db.getRun(view.run_id)) === null
        ? { seats: [], records: [], done: [] }
        : await runViewFacts(db, view.run_id);
  const runIds = new Set([
    ...rows.seats.map((seat) => seat.dispatch.run_id),
    ...rows.records.flatMap(({ record }) =>
      record.run_id === null ? [] : [record.run_id],
    ),
    ...rows.done.map((item) => item.run_id),
  ]);
  const runs: RunFact[] = [];
  for (const runId of [...runIds].sort())
    runs.push(await runFact(db, runId, scale));
  return { view, time_zone: timeZone, runs, ...rows };
}
