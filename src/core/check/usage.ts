import type { Run } from "../domain/ledger.ts";
import { seatProviders, SeatsInvalid } from "../dispatch/seats.ts";
import { pinnedConfig } from "../gate/receipt.ts";
import type { Repo } from "../ports/db.ts";

const hourMs = 3_600_000;

export async function recordNoSource(
  repo: Repo,
  run: Run,
  now: Date,
): Promise<string[]> {
  const pinned = await pinnedConfig(repo, run.run_id);
  if (pinned === null) return [];
  let providers: string[];
  try {
    providers = seatProviders(pinned.crew);
  } catch (error) {
    if (error instanceof SeatsInvalid)
      return [`usage observation skipped: ${error.path}`];
    throw error;
  }
  const latest = new Map(
    (await repo.latestUsageObservations(providers)).map((row) => [
      row.provider,
      row,
    ]),
  );
  const due = providers.filter((provider) => {
    const row = latest.get(provider);
    if (row === undefined) return true;
    return (
      row.coverage === "no_source" &&
      now.getTime() - row.observed_at.getTime() > hourMs
    );
  });
  for (const provider of due)
    await repo.insertUsageObservation({
      provider,
      seat: null,
      window_start: now,
      window_end: now,
      value: null,
      coverage: "no_source",
      observed_at: now,
      source: { kind: "none" },
    });
  return due.length === 0
    ? []
    : [`usage has no source for ${due.join(", ")}; pod state shows unknown`];
}
