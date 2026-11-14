import { activeRate, parseRate, type RateValue } from "../config/rate.ts";
import type { UsageRecord } from "../domain/usage.ts";
import type { Repo } from "../ports/db.ts";

export interface Cost {
  basis: "list-price equivalent";
  cost: number | null;
  currency: string | null;
  reason: "unpriced" | null;
  rate_revision_id: string | null;
}

export interface PinnedRate {
  id: string;
  value: RateValue;
}

type Priced = Pick<
  UsageRecord,
  | "runtime"
  | "model"
  | "input"
  | "cached_input"
  | "cache_write"
  | "output"
  | "reasoning"
>;

export function listPrice(row: Priced, rate: PinnedRate | null): Cost {
  const price = rate?.value.prices.find(
    (entry) => entry.runtime === row.runtime && entry.model === row.model,
  );
  if (rate === null || price === undefined)
    return {
      basis: "list-price equivalent",
      cost: null,
      currency: null,
      reason: "unpriced",
      rate_revision_id: rate?.id ?? null,
    };
  const units =
    (row.input ?? 0) * price.input +
    (row.cached_input ?? 0) * price.cached_input +
    (row.cache_write ?? 0) * price.cache_write +
    (row.output ?? 0) * price.output;
  return {
    basis: "list-price equivalent",
    cost: units / price.per,
    currency: rate.value.currency,
    reason: null,
    rate_revision_id: rate.id,
  };
}

async function recordRun(db: Repo, record: UsageRecord): Promise<string> {
  if (record.run_id !== null) return record.run_id;
  if (record.dispatch_id === null)
    throw new Error(`usage record ${record.id} has no Run`);
  const dispatch = await db.getDispatch(record.dispatch_id);
  if (dispatch === null)
    throw new Error(
      `usage record ${record.id} names Dispatch ${record.dispatch_id}, which the ledger lacks`,
    );
  return dispatch.run_id;
}

async function rateOf(
  db: Repo,
  record: UsageRecord,
): Promise<PinnedRate | null> {
  let id: string | null;
  if (record.attribution === "unattributed") {
    id = (await db.getActivation(activeRate))?.revision_id ?? null;
  } else {
    const runId = await recordRun(db, record);
    const snapshot = await db.getSnapshot(runId);
    if (snapshot === null)
      throw new Error(
        `Run ${runId} of usage record ${record.id} has no snapshot`,
      );
    id = snapshot.rate_revision_id;
  }
  if (id === null) return null;
  const revision = await db.getRevision(id);
  if (revision === null) throw new Error(`rate Revision ${id} is missing`);
  return { id, value: parseRate(revision.value) };
}

export async function usageCost(db: Repo, record: UsageRecord): Promise<Cost> {
  return listPrice(record, await rateOf(db, record));
}
