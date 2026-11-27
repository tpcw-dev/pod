import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { serviceKinds } from "../core/config/service-kinds.ts";
import { Size } from "../core/domain/ledger.ts";
import type { Refusal } from "../core/domain/outcome.ts";
import {
  activeGroomRevision,
  noActiveGroom,
  proposeGroom,
} from "../core/groom/propose.ts";
import { receiptLog } from "../core/ledger/receipts.ts";
import { planHost } from "../core/plan/host.ts";
import type { GitPort } from "../core/ports/git.ts";
import type { RepoReader } from "../core/ports/repo-reader.ts";
import { exitFor, PodError, throwRecordRefusal, usageError } from "./errors.ts";
import { realGit } from "./git.ts";
import {
  credentialStep,
  databaseUrl,
  readHostProfile,
} from "./host-profile.ts";
import { actorOf, writerOf } from "./identity.ts";
import { realRepoReader } from "./repo-reader.ts";
import { quote } from "../core/domain/shell.ts";
import { trackerFor } from "./tracker.ts";

const checkTimeoutMs = 300_000;

const Many = z.array(z.string().min(1)).optional();

export const GroomInput = z.strictObject({
  args: z.tuple([z.string().regex(/^story:.+$/)]),
  points: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  reason: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  at: z.string().min(1).optional(),
  function: Many,
  asserts: Many,
  check: Many,
  files: Many,
  json: z.boolean().optional(),
});
type GroomInput = z.infer<typeof GroomInput>;

const CheckState = z.enum(["passes", "fails", "missing", "writes", "timeout"]);

export const GroomOutput = z.object({
  story: z.object({
    provider: z.string(),
    external_id: z.string(),
    title: z.string(),
  }),
  stage: z.string(),
  points: z.int(),
  proposed: z.boolean(),
  reason: z.string(),
  size: Size,
  kickoff: z.string(),
  groom_revision: z.string(),
  ref: z.string(),
  sha: z.string(),
  date: z.string(),
  counters: z.object({
    callers: z.int(),
    fakes: z.int(),
    asserting: z.int(),
    failing: z.int(),
    checks: z.int(),
  }),
  sites: z.array(
    z.object({
      path: z.string(),
      line: z.int(),
      kind: z.enum(["caller", "fake", "definition", "test"]),
      function: z.string(),
    }),
  ),
  asserting: z.array(
    z.object({ test: z.string(), matched: z.array(z.string()) }),
  ),
  helpers: z.array(
    z.object({ path: z.string(), line: z.int(), matched: z.string() }),
  ),
  checks: z.array(
    z.object({
      command: z.string(),
      state: CheckState,
      exit: z.int().nullable(),
    }),
  ),
  paths: z.array(z.object({ path: z.string(), present: z.boolean() })),
  proved: z.string(),
  body: z.string(),
  op_key: z.string(),
  recorded: z.boolean(),
  delivered: z.object({ acked: z.int(), failed: z.int() }),
});
type GroomOutput = z.infer<typeof GroomOutput>;

function failWith(refusal: Refusal): never {
  throw new PodError(
    refusal.code,
    exitFor(refusal.code),
    refusal.message,
    refusal.nextSteps,
  );
}

function toplevel(path: string): string {
  const result = spawnSync(
    "git",
    ["-C", path, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw usageError(`${path} is not a git checkout`, [
      "pass --repo as the path of a git checkout",
    ]);
  return result.stdout.trim();
}

export async function resolveAt(
  git: GitPort,
  reader: RepoReader,
  repo: string,
  at: string | undefined,
): Promise<{ ref: string; sha: string }> {
  let ref = at;
  if (ref === undefined) {
    if (!(await git.fetch(repo)))
      throw usageError(`git fetch origin failed in ${repo}`, [
        "check the origin remote",
        "pass --at SHA",
      ]);
    const integration = await git.integration(repo);
    if (integration === null)
      throw usageError(`origin/HEAD is not set in ${repo}`, [
        `git -C ${repo} remote set-head origin --auto`,
        "pass --at SHA",
      ]);
    ref = `origin/${integration}`;
  }
  const sha = await reader.resolve(repo, ref);
  if (sha === null)
    throw usageError(`${ref} does not name a commit in ${repo}`, [
      "pass --at as a commit, branch, or tag of the repository",
    ]);
  return { ref, sha };
}

function inRepo(root: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(root, path);
  return inside.startsWith("..") ? path : inside;
}

export function groomCommand(input: Omit<GroomInput, "json">): string {
  const [story] = input.args;
  const one = (flag: string, value: string | undefined) =>
    value === undefined ? [] : [flag, quote(value)];
  const many = (flag: string, values: readonly string[] | undefined) =>
    (values ?? []).flatMap((value) => [flag, quote(value)]);
  return [
    "pod groom",
    story,
    ...one("--points", input.points),
    ...one("--reason", input.reason),
    ...one("--stage", input.stage),
    ...one("--repo", input.repo),
    ...one("--at", input.at),
    ...many("--function", input.function),
    ...many("--asserts", input.asserts),
    ...many("--check", input.check),
    ...many("--files", input.files),
  ].join(" ");
}

export async function groomVerb(input: GroomInput): Promise<GroomOutput> {
  if ((input.points === undefined) !== (input.reason === undefined))
    throw usageError("--points and --reason go together", [
      "pod groom story:<key> --points N --reason TEXT",
    ]);
  const [story] = input.args;
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const db = connection.db;
    const log = receiptLog(db, host.hostId);
    const kinds = await serviceKinds(db);
    const tracker = await trackerFor(
      log.trackerSink,
      host,
      kinds.estimateScale,
    );
    if (tracker === null)
      throw usageError(`pod groom needs ${host.trackerTokenEnv}`, [
        credentialStep(host, host.trackerTokenEnv, "tracker token"),
      ]);
    if ((await activeGroomRevision(db)) === null) failWith(noActiveGroom().refusal);
    const actor = actorOf(await writerOf(db, host, process.env, null));
    const repo = toplevel(resolve(input.repo ?? process.cwd()));
    const { ref, sha } = await resolveAt(
      realGit,
      realRepoReader,
      repo,
      input.at,
    );
    const now = new Date();
    const day = await planHost(db, host.hostId, now);
    if (!day.ok) failWith(day.refusal);
    const outcome = await proposeGroom(db, tracker.port, realRepoReader, log, {
      story: { provider: kinds.trackerKind, external_id: story.slice(6) },
      stage: input.stage ?? null,
      points: input.points === undefined ? null : Number(input.points),
      reason: input.reason ?? null,
      repo,
      sha,
      ref,
      date: day.day,
      functions: input.function ?? [],
      asserts: input.asserts ?? [],
      checks: input.check ?? [],
      files: (input.files ?? []).map((path) => inRepo(repo, path)),
      timeoutMs: checkTimeoutMs,
      host: host.hostId,
      actor,
      command: groomCommand(input),
      now: () => new Date(),
    });
    throwRecordRefusal(tracker.recordRefusals());
    if (!outcome.ok) failWith(outcome.refusal);
    return outcome.result;
  } finally {
    await connection.close();
  }
}

export function renderGroom(output: GroomOutput): string {
  return [
    output.body,
    "",
    ...output.sites.map(
      (site) => `${site.kind} ${site.path}:${site.line} ${site.function}`,
    ),
    ...output.asserting.map(
      (test) => `asserts ${test.test} (${test.matched.join(", ")})`,
    ),
    ...output.helpers.map(
      (helper) => `helper ${helper.path}:${helper.line} (${helper.matched})`,
    ),
    ...output.checks.map(
      (run) =>
        `check ${run.state} ${run.exit === null ? "-" : run.exit} ${run.command}`,
    ),
    ...output.paths.map(
      (fact) => `path ${fact.present ? "present" : "absent"} ${fact.path}`,
    ),
  ].join("\n");
}
