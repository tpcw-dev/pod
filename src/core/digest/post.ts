import { canonicalJson, sha256Hex } from "../config/canonical-json.ts";
import { digestCap } from "../config/digest-cap.ts";
import {
  dayOf,
  scopeOf,
  type DigestProposal,
  type ProposalFileRow,
} from "../domain/digest.ts";
import { Json } from "../domain/json.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";

export interface PostInput {
  project: string | null;
  proposals: ProposalFileRow[];
  host: string;
  now: () => Date;
}

export interface ShownProposal {
  number: number;
  theme: string;
  text: string;
  carried: boolean;
}

export type Posted =
  | {
      ok: true;
      scope: string;
      day: string;
      cap: number;
      shown: ShownProposal[];
      queued: number;
      replayed: boolean;
      opKey: string;
    }
  | Refused;

function sortedIds(row: ProposalFileRow): number[] {
  return [...row.learning_ids].sort((a, b) => a - b);
}

export function proposalKey(scope: string, row: ProposalFileRow): string {
  return sha256Hex(
    canonicalJson({
      scope,
      theme: row.theme,
      text: row.text,
      learning_ids: sortedIds(row),
    }),
  );
}

function badLearning(index: number, id: number, why: string): Refused {
  return refuse(
    "schema_invalid",
    `proposals[${index}].learning_ids: learning ${id} ${why}`,
    [`proposals[${index}].learning_ids`],
  );
}

async function checkLearnings(
  tx: Repo,
  project: string | null,
  fresh: readonly { index: number; row: ProposalFileRow }[],
  claimed: ReadonlySet<number>,
): Promise<Refused | null> {
  for (const { index, row } of fresh)
    for (const id of row.learning_ids) {
      const learning = await tx.getLearning(id);
      if (learning === null) return badLearning(index, id, "does not exist");
      if (learning.project_id !== project)
        return badLearning(index, id, `belongs to ${scopeOf(learning.project_id)}`);
      if (learning.adoption !== "new")
        return badLearning(index, id, `is ${learning.adoption}, not new`);
      if (claimed.has(id))
        return badLearning(index, id, "is in an unruled proposal");
    }
  return null;
}

function shownView(day: string) {
  return (row: DigestProposal): ShownProposal => ({
    number: row.id,
    theme: row.theme,
    text: row.text,
    carried: row.posted_on < day,
  });
}

async function showQueued(
  tx: Repo,
  scope: string,
  day: string,
  cap: number,
  now: Date,
): Promise<DigestProposal[]> {
  const queued = (await tx.listOpenProposals(scope)).filter(
    (row) => row.shown_on === null,
  );
  const shown = queued.slice(0, cap);
  for (const row of shown) {
    await tx.showDigestProposal(row.id, day);
    for (const id of row.learning_ids) {
      await tx.setLearningAdoption(id, "proposed", now);
      await tx.setLearningTheme(id, row.theme);
    }
  }
  return shown;
}

async function writeDigest(tx: Repo, input: PostInput): Promise<Posted> {
  const now = input.now();
  const scope = scopeOf(input.project);
  const day = dayOf(now);
  const open = await tx.listOpenProposals(scope);
  const stored = new Set(open.map((row) => row.proposal_key));
  const keyed = input.proposals.map((row, index) => ({
    index,
    row,
    key: proposalKey(scope, row),
  }));
  const fresh = keyed.filter((item) => !stored.has(item.key));
  const claimed = new Set(open.flatMap((row) => row.learning_ids));
  const refused = await checkLearnings(tx, input.project, fresh, claimed);
  if (refused !== null) return refused;
  for (const { row, key } of fresh)
    await tx.insertDigestProposal({
      proposal_key: key,
      scope,
      posted_on: day,
      theme: row.theme,
      text: row.text,
      learning_ids: sortedIds(row),
      evidence_refs: row.evidence_refs,
      created_at: now,
    });
  const cap = await digestCap(tx, input.project);
  const opKey = `digest:${scope}:${day}`;
  const operation = await tx.insertOperation({
    op_key: opKey,
    intent: "digest",
    owner_generation: 0,
    at: now,
    result_ref: Json.parse({ scope, day }),
  });
  if (operation.created) {
    const shown = await showQueued(tx, scope, day, cap, now);
    const queued = (await tx.listOpenProposals(scope)).filter(
      (row) => row.shown_on === null,
    );
    await tx.appendEvent({
      type: "digest",
      ts: now,
      host: input.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse({
        scope,
        day,
        cap,
        shown: shown.map((row) => ({
          number: row.id,
          theme: row.theme,
          text: row.text,
          learning_ids: row.learning_ids,
          evidence_refs: row.evidence_refs,
          carried: row.posted_on < day,
        })),
        queued: queued.map((row) => ({
          number: row.id,
          theme: row.theme,
          posted_on: row.posted_on,
        })),
      }),
      source: Json.parse({ kind: "command", verb: "digest post" }),
    });
    await tx.moveOperation(opKey, "done", Json.parse({ scope, day }), now);
  }
  const today = await tx.listShownProposals(scope, day);
  const queued = (await tx.listOpenProposals(scope)).filter(
    (row) => row.shown_on === null,
  );
  return {
    ok: true,
    scope,
    day,
    cap,
    shown: today.map(shownView(day)),
    queued: queued.length,
    replayed: !operation.created && fresh.length === 0,
    opKey,
  };
}

export function postDigest(db: Db, input: PostInput): Promise<Posted> {
  return db.transaction((tx) => writeDigest(tx, input));
}
