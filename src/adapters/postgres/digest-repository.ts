import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  Verdict,
  type DigestProposal,
  type NewDigestProposal,
} from "../../core/domain/digest.ts";
import type { Repo } from "../../core/ports/db.ts";
import { digestProposal } from "../../db/schema/ledger.ts";

type Executor = Pick<
  PostgresJsDatabase<Record<string, never>>,
  "select" | "insert" | "update"
>;

type DigestRepo = Pick<
  Repo,
  | "insertDigestProposal"
  | "getDigestProposal"
  | "listOpenProposals"
  | "listShownProposals"
  | "showDigestProposal"
  | "ruleDigestProposal"
>;

const LearningIds = z.array(z.number());
const EvidenceRefs = z.array(z.string());

function toProposal(row: typeof digestProposal.$inferSelect): DigestProposal {
  return {
    id: row.id,
    proposal_key: row.proposalKey,
    scope: row.scope,
    posted_on: row.postedOn,
    theme: row.theme,
    text: row.text,
    learning_ids: LearningIds.parse(row.learningIds),
    evidence_refs: EvidenceRefs.parse(row.evidenceRefs),
    shown_on: row.shownOn,
    ruling: row.ruling === null ? null : Verdict.parse(row.ruling),
    ruled_at: row.ruledAt,
    created_at: row.createdAt,
  };
}

const openKey = isNull(digestProposal.ruling);

export function makeDigestRepo(x: Executor): DigestRepo {
  return {
    async insertDigestProposal(row: NewDigestProposal) {
      const [inserted] = await x
        .insert(digestProposal)
        .values({
          proposalKey: row.proposal_key,
          scope: row.scope,
          postedOn: row.posted_on,
          theme: row.theme,
          text: row.text,
          learningIds: row.learning_ids,
          evidenceRefs: row.evidence_refs,
          createdAt: row.created_at,
        })
        .onConflictDoNothing({
          target: digestProposal.proposalKey,
          where: sql`${digestProposal.ruling} is null`,
        })
        .returning();
      if (inserted !== undefined)
        return { proposal: toProposal(inserted), created: true };
      const [existing] = await x
        .select()
        .from(digestProposal)
        .where(and(eq(digestProposal.proposalKey, row.proposal_key), openKey));
      if (existing === undefined)
        throw new Error("digest proposal conflict returned no row");
      return { proposal: toProposal(existing), created: false };
    },

    async getDigestProposal(id) {
      const [row] = await x
        .select()
        .from(digestProposal)
        .where(eq(digestProposal.id, id));
      return row === undefined ? null : toProposal(row);
    },

    async listOpenProposals(scope) {
      const rows = await x
        .select()
        .from(digestProposal)
        .where(and(eq(digestProposal.scope, scope), openKey))
        .orderBy(asc(digestProposal.postedOn), asc(digestProposal.id));
      return rows.map(toProposal);
    },

    async listShownProposals(scope, day) {
      const rows = await x
        .select()
        .from(digestProposal)
        .where(
          and(eq(digestProposal.scope, scope), eq(digestProposal.shownOn, day)),
        )
        .orderBy(asc(digestProposal.id));
      return rows.map(toProposal);
    },

    async showDigestProposal(id, day) {
      await x
        .update(digestProposal)
        .set({ shownOn: day })
        .where(eq(digestProposal.id, id));
    },

    async ruleDigestProposal(id, verdict, at) {
      const rows = await x
        .update(digestProposal)
        .set({ ruling: verdict, ruledAt: at })
        .where(and(eq(digestProposal.id, id), openKey))
        .returning({ id: digestProposal.id });
      return rows.length === 1;
    },
  };
}
