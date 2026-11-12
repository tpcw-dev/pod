import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { decideDigest } from "../core/digest/decide.ts";
import { postDigest } from "../core/digest/post.ts";
import { prepareDigest } from "../core/digest/prepare.ts";
import { assignStory, digestQueue } from "../core/digest/queue.ts";
import { acceptProposalFile, Verdict } from "../core/domain/digest.ts";
import type { Refusal } from "../core/domain/outcome.ts";
import type { Db } from "../core/ports/db.ts";
import { PodError, exitFor, schemaError, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import { actorOf, needsPerson, writerOf } from "./identity.ts";
import { parseYaml, readText } from "./yaml-file.ts";

function failWith(refusal: Refusal): never {
  throw new PodError(
    refusal.code,
    exitFor(refusal.code),
    refusal.message,
    refusal.nextSteps,
  );
}

async function withDb<T>(
  work: (db: Db, hostId: string) => Promise<T>,
  host = readHostProfile(),
): Promise<T> {
  const connection = connect(databaseUrl(host));
  try {
    return await work(connection.db, host.hostId);
  } finally {
    await connection.close();
  }
}

function positiveInt(name: string, value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value))
    throw usageError(`${name} must be a positive integer, got ${value}`);
  return Number(value);
}

export const DigestPrepareInput = z.strictObject({
  args: z.tuple([]),
  project: z.string().min(1).optional(),
});
type DigestPrepareInput = z.infer<typeof DigestPrepareInput>;

export const DigestPrepareOutput = z.object({
  scope: z.string(),
  day: z.string(),
  cap: z.number(),
  watermark: z.string().nullable(),
  learnings: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      area: z.string(),
      text: z.string(),
      expected: z.string().nullable(),
      evidence_refs: z.array(z.string()),
      source_story: z.string(),
      occurrences: z.number(),
    }),
  ),
  fail_receipts: z.array(
    z.object({
      id: z.number(),
      gate_id: z.string(),
      run_id: z.string(),
      task_id: z.string(),
      scope: z.string(),
      candidate_sha: z.string(),
      keeper: z.string(),
      created_at: z.string(),
    }),
  ),
  queued: z.array(
    z.object({
      number: z.number(),
      posted_on: z.string(),
      theme: z.string(),
      text: z.string(),
      learning_ids: z.array(z.number()),
      evidence_refs: z.array(z.string()),
    }),
  ),
});
type DigestPrepareOutput = z.infer<typeof DigestPrepareOutput>;

export function digestPrepare(
  input: DigestPrepareInput,
): Promise<DigestPrepareOutput> {
  return withDb((db) =>
    prepareDigest(db, {
      project: input.project ?? null,
      now: () => new Date(),
    }),
  );
}

export const DigestPostInput = z.strictObject({
  args: z.tuple([z.string()]),
  project: z.string().min(1).optional(),
});
type DigestPostInput = z.infer<typeof DigestPostInput>;

export const DigestPostOutput = z.object({
  scope: z.string(),
  day: z.string(),
  cap: z.number(),
  shown: z.array(
    z.object({
      number: z.number(),
      theme: z.string(),
      text: z.string(),
      carried: z.boolean(),
    }),
  ),
  queued: z.number(),
  replayed: z.boolean(),
  op_key: z.string(),
});
type DigestPostOutput = z.infer<typeof DigestPostOutput>;

export function opKeyMeta(output: { op_key: string }) {
  return { opKey: output.op_key };
}

export async function digestPost(
  input: DigestPostInput,
): Promise<DigestPostOutput> {
  const [path] = input.args;
  const accepted = acceptProposalFile(parseYaml(readText(path), path));
  if (!accepted.ok)
    throw schemaError(`${path} fails the digest proposal schema`, accepted.issues);
  const outcome = await withDb((db, hostId) =>
    postDigest(db, {
      project: input.project ?? null,
      proposals: accepted.proposals,
      host: hostId,
      now: () => new Date(),
    }),
  );
  if (!outcome.ok) failWith(outcome.refusal);
  return {
    scope: outcome.scope,
    day: outcome.day,
    cap: outcome.cap,
    shown: outcome.shown,
    queued: outcome.queued,
    replayed: outcome.replayed,
    op_key: outcome.opKey,
  };
}

export const DigestDecideInput = z.strictObject({
  args: z.tuple([z.string()]),
  accept: z.boolean().optional(),
  reject: z.boolean().optional(),
  reason: z.string().min(1),
});
type DigestDecideInput = z.infer<typeof DigestDecideInput>;

export const DigestDecideOutput = z.object({
  scope: z.string(),
  day: z.string(),
  number: z.number(),
  verdict: Verdict,
  learning_ids: z.array(z.number()),
  op_key: z.string(),
});
type DigestDecideOutput = z.infer<typeof DigestDecideOutput>;

export async function digestDecide(
  input: DigestDecideInput,
): Promise<DigestDecideOutput> {
  const number = positiveInt("n", input.args[0]);
  if (input.accept === input.reject)
    throw usageError("pass exactly one of --accept and --reject");
  const verdict = input.accept === true ? "accept" : "reject";
  const host = readHostProfile();
  const outcome = await withDb(async (db, hostId) => {
    const identity = await writerOf(db, host, process.env, false);
    needsPerson(identity, "a digest ruling", [
      "Run pod digest decide from the operator's shell",
      "An agent Seat proposes with pod digest post",
    ]);
    return decideDigest(db, {
      number,
      verdict,
      reason: input.reason,
      actor: actorOf(identity),
      host: hostId,
      now: () => new Date(),
    });
  }, host);
  if (!outcome.ok) failWith(outcome.refusal);
  return {
    scope: outcome.scope,
    day: outcome.day,
    number: outcome.number,
    verdict: outcome.verdict,
    learning_ids: outcome.learning_ids,
    op_key: outcome.opKey,
  };
}

export const DigestQueueInput = z.strictObject({
  args: z.tuple([]),
  project: z.string().min(1).optional(),
});
type DigestQueueInput = z.infer<typeof DigestQueueInput>;

export const DigestQueueOutput = z.object({
  scope: z.string(),
  themes: z.array(
    z.object({
      theme: z.string().nullable(),
      learnings: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          area: z.string(),
          text: z.string(),
          evidence_refs: z.array(z.string()),
        }),
      ),
    }),
  ),
});
type DigestQueueOutput = z.infer<typeof DigestQueueOutput>;

export function digestQueueVerb(
  input: DigestQueueInput,
): Promise<DigestQueueOutput> {
  return withDb((db) => digestQueue(db, input.project ?? null));
}

const storyArg = z.string().regex(/^story:.+$/u);

export const DigestAssignInput = z.strictObject({
  args: z.tuple([z.string(), storyArg]),
});
type DigestAssignInput = z.infer<typeof DigestAssignInput>;

export const DigestAssignOutput = z.object({
  id: z.number(),
  action_story: z.string(),
  changed: z.boolean(),
});
type DigestAssignOutput = z.infer<typeof DigestAssignOutput>;

export async function digestAssign(
  input: DigestAssignInput,
): Promise<DigestAssignOutput> {
  const [idArg, storyRef] = input.args;
  const id = positiveInt("learning_id", idArg);
  const outcome = await withDb((db) =>
    assignStory(db, { id, story: storyRef.slice("story:".length) }),
  );
  if (!outcome.ok) failWith(outcome.refusal);
  return {
    id: outcome.id,
    action_story: outcome.action_story,
    changed: outcome.changed,
  };
}
