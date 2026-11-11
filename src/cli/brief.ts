import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import {
  globalProject,
  projectProfiles,
  type ProjectProfile,
} from "../core/brief/profiles.ts";
import { pendingActivations, revisionRef } from "../core/config/apply.ts";
import { revisionId } from "../core/config/canonical-json.ts";
import { mirrorPath, mirrorSet, scopeText } from "../core/config/mirror.ts";
import type { BriefTree } from "../core/domain/brief.ts";
import type { Repo } from "../core/ports/db.ts";
import { RevisionEnvelope, type Revision } from "../core/domain/config.ts";
import { Json } from "../core/domain/json.ts";
import { renderBriefHtml } from "../core/manifest/html.ts";
import { waitingOn } from "../core/process/waiting.ts";
import { PodError } from "./errors.ts";
import {
  databaseUrl,
  readCredentials,
  readHostProfile,
} from "./host-profile.ts";
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
  ref: z.string(),
  kind: z.string(),
  name: z.string(),
  scope: z.string(),
  path: z.string().nullable(),
  mark: z.literal("mirror stale"),
});

const CountersJson = z.object({
  coordinator_operations: z.number(),
  recovery_steps: z.number(),
  retries: z.number(),
  rework_tasks: z.number(),
  hand_filled: z.number(),
  fallback_launches: z.number(),
  model_mismatches: z.number(),
});

const SeatMeasureJson = z.object({
  seat: z.string(),
  prompt_bytes: z.number().nullable(),
  cold_start_ms: z.number().nullable(),
});

const MeasurementJson = z.object({
  pair: z
    .object({ decider: SeatMeasureJson, auditor: SeatMeasureJson.nullable() })
    .nullable(),
  decisions: z.array(
    z.object({
      decision_id: z.string(),
      state: z.string(),
      reason: z.string().nullable(),
      effect: z.string().nullable(),
      outcome: z.enum(["adopted", "reworked", "reversed", "open"]),
    }),
  ),
  escalations: z.object({
    "policy-required": z.number(),
    disagreement: z.number(),
    "context-missing": z.number(),
    "runtime-failure": z.number(),
    worker: z.number(),
    sample: z.number(),
    target: z.number(),
  }),
});

const TestJson = z.object({
  command: z.string(),
  exit_code: z.number(),
  seconds: z.number(),
  timeout_seconds: z.number().nullable(),
});

const PendingRequestJson = z.object({
  op_key: z.string(),
  ref: z.string(),
  scope: z.string(),
  ticket: z.string().nullable(),
  actor: z.string().nullable(),
  comment: z.string(),
});

export const BriefOutput = z.object({
  pending_requests: z.array(PendingRequestJson),
  projects: z.array(
    z.object({
      project: z.string(),
      profile: z.string().nullable(),
      policy: z.string().nullable(),
      line: z.string(),
    }),
  ),
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
          profile: z.string().nullable(),
          profile_stale: z.boolean(),
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
              seat: z.string(),
              note: z.string().nullable(),
              manifest_id: z.string().nullable(),
              activity: z.string(),
              settlement: z.string(),
              created_at: z.string(),
              tests: z.array(TestJson),
            }),
          ),
          counters: CountersJson,
          measurement: MeasurementJson,
        }),
      ),
    }),
  ),
  drift: z.array(DriftJson),
  nextSteps: z.array(z.string()).optional(),
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

async function mirrorDrift(repo: Repo): Promise<BriefResult["drift"]> {
  const drift: BriefResult["drift"] = [];
  for (const revision of await mirrorSet(repo)) {
    const path = mirrorPath(revision);
    if (path !== null && fileMatches(path, revision)) continue;
    drift.push({
      revision_id: revision.id,
      ref: revisionRef(revision),
      kind: revision.kind,
      name: revision.name,
      scope: scopeText(revision),
      path,
      mark: "mirror stale",
    });
  }
  return drift;
}

async function pendingRequests(
  repo: Repo,
): Promise<z.infer<typeof PendingRequestJson>[]> {
  const rows: z.infer<typeof PendingRequestJson>[] = [];
  for (const { op_key, request } of await pendingActivations(repo)) {
    const revision = await repo.getRevision(request.revision_id);
    rows.push({
      op_key,
      ref: revision === null ? request.revision_id : revisionRef(revision),
      scope: scopeText(request),
      ticket: request.ticket,
      actor: request.actor,
      comment: request.comment,
    });
  }
  return rows;
}

function toBriefResult(
  tree: BriefTree,
  projects: readonly ProjectProfile[],
  pending: BriefResult["pending_requests"],
  drift: BriefResult["drift"],
): BriefResult {
  const current = new Map(projects.map((row) => [row.project, row.profile]));
  return {
    pending_requests: pending,
    projects: [...projects],
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
        profile: run.snapshot?.profile ?? null,
        profile_stale:
          run.snapshot !== null &&
          run.snapshot.profile !==
            (current.get(run.snapshot.project ?? globalProject) ?? null),
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
          seat: dispatch.seat,
          note:
            dispatch.fallback_of === null
              ? null
              : `fallback of ${dispatch.fallback_of}`,
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
        measurement: run.measurement,
      })),
    })),
    drift,
  };
}

export async function brief(input: BriefInput): Promise<BriefResult> {
  const arg = input.args[0];
  const externalId = arg === undefined ? null : arg.slice("story:".length);
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const drift = await mirrorDrift(connection.db);
    const nextSteps = [
      ...readCredentials(host).warnings(),
      ...(drift.length === 0 ? [] : ["pod config export --all"]),
    ];
    const tree = await connection.db.readBrief(externalId);
    if (externalId !== null && tree.stories.length === 0)
      throw new PodError(
        "story_not_found",
        3,
        `no Story has external_id ${externalId}`,
        ["pod brief"],
      );
    const result = BriefOutput.parse({
      ...toBriefResult(
        tree,
        await projectProfiles(connection.db, tree),
        await pendingRequests(connection.db),
        drift,
      ),
      ...(nextSteps.length === 0 ? {} : { nextSteps }),
    });
    if (input.html !== undefined)
      writeFileSync(input.html, renderBriefHtml(JSON.stringify(result)));
    return result;
  } finally {
    await connection.close();
  }
}
