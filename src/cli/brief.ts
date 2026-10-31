import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { revisionId } from "../core/config/canonical-json.ts";
import type { BriefTree } from "../core/domain/brief.ts";
import { RevisionEnvelope, type Revision } from "../core/domain/config.ts";
import { Json } from "../core/domain/json.ts";
import { renderBriefHtml } from "../core/manifest/html.ts";
import { waitingOn } from "../core/process/waiting.ts";
import { PodError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { parseYaml } from "./yaml-file.ts";

const storyArg = z.string().regex(/^story:.+$/);

export const BriefInput = z.strictObject({
  args: z.union([z.tuple([]), z.tuple([storyArg])]),
  html: z.string().min(1).optional(),
});
type BriefInput = z.infer<typeof BriefInput>;

const RevisionJson = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  rev: z.int(),
  created_at: z.string(),
});

const DriftJson = z.object({
  revision_id: z.string(),
  kind: z.string(),
  name: z.string(),
  path: z.string(),
});

const CountersJson = z.object({
  coordinator_operations: z.number(),
  recovery_steps: z.number(),
  retries: z.number(),
  rework_tasks: z.number(),
  hand_filled: z.number(),
});

const TestJson = z.object({
  command: z.string(),
  exit_code: z.number(),
  seconds: z.number(),
  timeout_seconds: z.number().nullable(),
});

export const BriefOutput = z.object({
  stories: z.array(
    z.object({
      provider: z.string(),
      external_id: z.string(),
      size: z.string(),
      stage: z.string(),
      run_id: z.string().nullable(),
      dependencies: Json,
      synced_at: z.string(),
      counters: CountersJson,
      runs: z.array(
        z.object({
          run_id: z.string(),
          state: z.string(),
          created_at: z.string(),
          snapshot: z
            .object({
              hash: z.string(),
              pinned_at: z.string(),
              crew: RevisionJson.nullable(),
              process: RevisionJson.nullable(),
              policy: RevisionJson.nullable(),
            })
            .nullable(),
          tasks: z.array(
            z.object({
              task_id: z.string(),
              state: z.string(),
              step_id: z.string(),
              role: z.string(),
              created_at: z.string(),
              waiting_on: z.string().nullable(),
            }),
          ),
          dispatches: z.array(
            z.object({
              dispatch_id: z.string(),
              task_id: z.string().nullable(),
              manifest_id: z.string().nullable(),
              activity: z.string(),
              settlement: z.string(),
              created_at: z.string(),
              tests: z.array(TestJson),
            }),
          ),
          counters: CountersJson,
        }),
      ),
      drift: z.array(DriftJson),
    }),
  ),
});
type BriefResult = z.infer<typeof BriefOutput>;

function iso(date: Date): string {
  return date.toISOString();
}

function revisionJson(revision: Revision | null) {
  if (revision === null) return null;
  return {
    id: revision.id,
    kind: revision.kind,
    name: revision.name,
    rev: revision.rev,
    created_at: iso(revision.created_at),
  };
}

function specPath(kind: string, name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(kind) || !/^[A-Za-z0-9._-]+$/.test(name))
    return null;
  return join("specs", kind, `${name}.yaml`);
}

function fileMatches(path: string, revision: Revision): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text, path);
  } catch {
    return false;
  }
  const envelope = RevisionEnvelope.safeParse(parsed);
  if (!envelope.success) return false;
  return revisionId(envelope.data) === revision.id;
}

function driftFor(
  tree: BriefTree,
): Map<string, BriefResult["stories"][number]["drift"]> {
  const byStory = new Map<string, BriefResult["stories"][number]["drift"]>();
  for (const item of tree.stories) {
    const seen = new Set<string>();
    const drift: BriefResult["stories"][number]["drift"] = [];
    for (const run of item.runs) {
      const snapshot = run.snapshot;
      if (snapshot === null) continue;
      const slots = [
        { id: snapshot.crew_revision_id, revision: snapshot.crew },
        { id: snapshot.process_revision_id, revision: snapshot.process },
        { id: snapshot.policy_revision_id, revision: snapshot.policy },
      ];
      for (const slot of slots) {
        if (seen.has(slot.id)) continue;
        seen.add(slot.id);
        if (slot.revision === null) {
          drift.push({
            revision_id: slot.id,
            kind: "missing",
            name: "missing",
            path: "specs/missing/missing.yaml",
          });
          continue;
        }
        const path = specPath(slot.revision.kind, slot.revision.name);
        if (path !== null && fileMatches(path, slot.revision)) continue;
        drift.push({
          revision_id: slot.revision.id,
          kind: slot.revision.kind,
          name: slot.revision.name,
          path: path ?? "specs/missing/missing.yaml",
        });
      }
    }
    byStory.set(`${item.story.provider}\n${item.story.external_id}`, drift);
  }
  return byStory;
}

function toBriefResult(tree: BriefTree): BriefResult {
  const drift = driftFor(tree);
  return {
    stories: tree.stories.map((item) => ({
      provider: item.story.provider,
      external_id: item.story.external_id,
      size: item.story.size,
      stage: item.story.stage,
      run_id: item.story.run_id,
      dependencies: item.story.dependencies,
      synced_at: iso(item.story.synced_at),
      counters: item.counters,
      runs: item.runs.map((run) => ({
        run_id: run.run.run_id,
        state: run.run.state,
        created_at: iso(run.run.created_at),
        snapshot:
          run.snapshot === null
            ? null
            : {
                hash: run.snapshot.hash,
                pinned_at: iso(run.snapshot.pinned_at),
                crew: revisionJson(run.snapshot.crew),
                process: revisionJson(run.snapshot.process),
                policy: revisionJson(run.snapshot.policy),
              },
        tasks: run.tasks.map((task) => ({
          task_id: task.task_id,
          state: task.state,
          step_id: task.step_id,
          role: task.role,
          created_at: iso(task.created_at),
          waiting_on: waitingOn(
            run.snapshot?.process ?? null,
            task,
            run.decisions.find((row) => row.task_id === task.task_id),
          ),
        })),
        dispatches: run.dispatches.map((dispatch) => ({
          dispatch_id: dispatch.dispatch_id,
          task_id: dispatch.task_id,
          manifest_id: dispatch.manifest_id,
          activity: dispatch.activity,
          settlement: dispatch.settlement,
          created_at: iso(dispatch.created_at),
          tests: dispatch.tests.map((row) => ({
            command: row.command,
            exit_code: row.exit_code,
            seconds: row.seconds,
            timeout_seconds: row.timeout_seconds,
          })),
        })),
        counters: run.counters,
      })),
      drift:
        drift.get(`${item.story.provider}\n${item.story.external_id}`) ?? [],
    })),
  };
}

export async function brief(input: BriefInput): Promise<BriefResult> {
  const arg = input.args[0];
  const externalId = arg === undefined ? null : arg.slice("story:".length);
  const connection = connect(databaseUrl(readHostProfile()));
  try {
    const tree = await connection.db.readBrief(externalId);
    if (externalId !== null && tree.stories.length === 0)
      throw new PodError(
        "story_not_found",
        3,
        `no Story has external_id ${externalId}`,
        ["pod brief"],
      );
    const result = BriefOutput.parse(toBriefResult(tree));
    if (input.html !== undefined)
      writeFileSync(input.html, renderBriefHtml(JSON.stringify(result)));
    return result;
  } finally {
    await connection.close();
  }
}
