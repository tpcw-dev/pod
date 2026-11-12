import type { Verdict } from "../domain/digest.ts";
import { Json } from "../domain/json.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";

export interface DecideInput {
  number: number;
  verdict: Verdict;
  reason: string;
  actor: string;
  host: string;
  now: () => Date;
}

export type Ruled =
  | {
      ok: true;
      scope: string;
      day: string;
      number: number;
      verdict: Verdict;
      learning_ids: number[];
      opKey: string;
    }
  | Refused;

function rulingExists(number: number): Refused {
  return refuse("ruling_exists", `proposal ${number} already has a ruling`, [
    "Run pod brief to see each proposal's ruling",
    "Run pod digest queue to see the accepted rows",
  ]);
}

async function writeRuling(tx: Repo, input: DecideInput): Promise<Ruled> {
  const proposal = await tx.getDigestProposal(input.number);
  const day = proposal?.shown_on ?? null;
  if (proposal === null || day === null)
    return refuse(
      "schema_invalid",
      `n: proposal ${input.number} is not a shown proposal`,
      ["Run pod brief for the shown proposal numbers"],
    );
  if (proposal.ruling !== null) return rulingExists(input.number);
  const now = input.now();
  const opKey = `ruling:${input.number}`;
  const operation = await tx.insertOperation({
    op_key: opKey,
    intent: "ruling",
    owner_generation: 0,
    at: now,
    result_ref: null,
  });
  if (!operation.created) return rulingExists(input.number);
  const adoption = input.verdict === "accept" ? "adopted" : "rejected";
  for (const id of proposal.learning_ids)
    await tx.setLearningAdoption(id, adoption, now);
  await tx.ruleDigestProposal(proposal.id, input.verdict, now);
  const payload = {
    scope: proposal.scope,
    day,
    number: proposal.id,
    verdict: input.verdict,
    reason: input.reason,
    learning_ids: proposal.learning_ids,
    actor: input.actor,
  };
  await tx.appendEvent({
    type: "ruling",
    ts: now,
    host: input.host,
    run_id: null,
    task_id: null,
    dispatch_id: null,
    op_key: opKey,
    payload: Json.parse(payload),
    source: Json.parse({
      kind: "command",
      verb: "digest decide",
      actor: input.actor,
    }),
  });
  await tx.moveOperation(opKey, "done", Json.parse(payload), now);
  return {
    ok: true,
    scope: proposal.scope,
    day,
    number: proposal.id,
    verdict: input.verdict,
    learning_ids: proposal.learning_ids,
    opKey,
  };
}

export function decideDigest(db: Db, input: DecideInput): Promise<Ruled> {
  return db.transaction((tx) => writeRuling(tx, input));
}
