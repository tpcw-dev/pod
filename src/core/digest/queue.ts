import { scopeOf } from "../domain/digest.ts";
import type { Learning } from "../domain/learning.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import type { Db, Repo } from "../ports/db.ts";

export async function tuningQueue(
  repo: Repo,
  project: string | null,
): Promise<Learning[]> {
  const adopted = await repo.listLearnings({ adoption: "adopted", project });
  return adopted
    .filter((row) => row.action_story === null)
    .sort((a, b) => a.id - b.id);
}

function byTheme(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export async function digestQueue(repo: Repo, project: string | null) {
  const groups = new Map<string | null, Learning[]>();
  for (const row of await tuningQueue(repo, project))
    groups.set(row.theme, [...(groups.get(row.theme) ?? []), row]);
  return {
    scope: scopeOf(project),
    themes: [...groups.entries()]
      .sort(([a], [b]) => byTheme(a, b))
      .map(([theme, rows]) => ({
        theme,
        learnings: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          area: row.area,
          text: row.text,
          evidence_refs: row.evidence_refs,
        })),
      })),
  };
}

export interface AssignInput {
  id: number;
  story: string;
}

export type Assigned =
  | { ok: true; id: number; action_story: string; changed: boolean }
  | Refused;

export function assignStory(db: Db, input: AssignInput): Promise<Assigned> {
  return db.transaction(async (tx) => {
    const row = await tx.getLearning(input.id);
    if (row === null || row.adoption !== "adopted")
      return refuse(
        "schema_invalid",
        `learning_id: learning ${input.id} is ${row?.adoption ?? "missing"}, not adopted`,
        ["Run pod digest queue for the accepted rows"],
      );
    const changed = row.action_story !== input.story;
    if (changed) await tx.setLearningActionStory(input.id, input.story);
    return { ok: true, id: input.id, action_story: input.story, changed };
  });
}
