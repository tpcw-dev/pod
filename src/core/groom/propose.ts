import { activeGroom, groomStages, parseGroom, type GroomValue } from "../config/groom.ts";
import { Json } from "../domain/json.ts";
import type { Size } from "../domain/ledger.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { RepoReader } from "../ports/repo-reader.ts";
import type { StoryRef, TrackerPort } from "../ports/tracker.ts";
import { activeProcesses } from "../process/active.ts";
import { selectProcess } from "../process/select.ts";
import { commentPayload, drainOutbox } from "../tracker/outbox.ts";
import {
  checkProposal,
  countersOf,
  defaultPoints,
  prove,
  provedLine,
  type Counters,
  type Proof,
} from "./proves.ts";

export const neverLaunched = "never_launched";
export const proposalHeading = "pod: groom proposal";

export interface ProposeInput {
  story: StoryRef;
  stage: string | null;
  points: number | null;
  reason: string | null;
  repo: string;
  sha: string;
  ref: string;
  date: string;
  functions: readonly string[];
  asserts: readonly string[];
  checks: readonly string[];
  files: readonly string[];
  timeoutMs: number;
  host: string;
  actor: string;
  command: string;
  now: () => Date;
}

export interface GroomProposal {
  story: { provider: string; external_id: string; title: string };
  stage: string;
  points: number;
  proposed: boolean;
  reason: string;
  size: Size;
  kickoff: string;
  groom_revision: string;
  ref: string;
  sha: string;
  date: string;
  counters: Counters;
  sites: Proof["sites"];
  asserting: Proof["asserting"];
  helpers: Proof["helpers"];
  checks: Proof["checks"];
  paths: Proof["paths"];
  proved: string;
  body: string;
  op_key: string;
  recorded: boolean;
  delivered: { acked: number; failed: number };
}

export async function activeGroomRevision(
  db: Db,
): Promise<{ id: string; groom: GroomValue } | null> {
  const id = (await db.getActivation(activeGroom))?.revision_id ?? null;
  const revision = id === null ? null : await db.getRevision(id);
  return revision === null
    ? null
    : { id: revision.id, groom: parseGroom(revision.value) };
}

async function kickoffOf(
  db: Db,
  groom: GroomValue,
  stage: string,
  points: number,
  size: Size,
): Promise<string | Refused> {
  const tier = groom.tiers[String(points)] ?? neverLaunched;
  if (tier === neverLaunched) return neverLaunched;
  const activations = await activeProcesses(db);
  if (stage === "impl") {
    const named = activations.filter((active) => active.name === tier);
    const [only] = named;
    if (only === undefined)
      return refuse(
        "selector_none",
        `no active process Revision is named ${tier}, the groom tier for ${points} points`,
        [`activate a process Revision named ${tier}`],
      );
    if (named.length > 1)
      return refuse(
        "selector_many",
        `${named.length} active process Revisions are named ${tier}`,
        ["leave one active process Revision of that name"],
      );
    return `${only.name}@${only.rev}`;
  }
  const selected = selectProcess({
    stage,
    size,
    kickoffLine: null,
    cliProcess: null,
    activations,
    named: null,
  });
  if (!selected.ok)
    return refuse(
      selected.code,
      `no single active process Revision fits stage ${stage} and size ${size}`,
      ["leave exactly one active process Revision whose selector fits"],
    );
  const found = activations.find(
    (active) => active.revisionId === selected.revisionId,
  );
  if (found === undefined)
    throw new Error(`selected process ${selected.revisionId} is not active`);
  return `${found.name}@${found.rev}`;
}

export function noActiveGroom(): Refused {
  return refuse("config_missing", "no groom Revision is active", [
    "pod config apply specs/groom/default.yaml",
  ]);
}

export function proposalBody(proposal: {
  stage: string;
  points: number;
  proposed: boolean;
  size: Size;
  kickoff: string;
  reason: string;
  proved: string;
}): string {
  return [
    proposalHeading,
    `Stage: ${proposal.stage}`,
    `Points: ${proposal.points}${proposal.proposed ? " (proposed)" : ""}`,
    `Size: ${proposal.size}`,
    `Kickoff: ${proposal.kickoff}`,
    `Reason: ${proposal.reason}`,
    proposal.proved,
  ].join("\n");
}

async function unconfirmed(
  db: Db,
  opKey: string,
  failed: number,
): Promise<boolean> {
  if (failed > 0) return true;
  return (await db.listOutboxParked()).some((row) => row.op_key === opKey);
}

export async function proposeGroom(
  db: Db,
  tracker: TrackerPort,
  reader: RepoReader,
  log: ReceiptLog,
  input: ProposeInput,
): Promise<{ ok: true; result: GroomProposal } | Refused> {
  const active = await activeGroomRevision(db);
  if (active === null) return noActiveGroom();
  const { groom } = active;
  log.at({ run_id: null, task_id: null, op_key: null });
  const read = await tracker.readStory(input.story);
  if (!read.ok)
    return refuse(
      "failed",
      `tracker read of story:${input.story.external_id} failed: ${read.error ?? "no reply"}`,
      [input.command],
    );
  if (read.result === null)
    return refuse(
      "story_not_found",
      `no Story ${input.story.external_id} in the tracker`,
      ["check the Story id"],
    );
  const story = read.result;
  const stage = input.stage ?? story.stageLabel;
  if (stage === null)
    return refuse(
      "usage",
      `story:${input.story.external_id} has no single stage: label`,
      [`${input.command} --stage <${groomStages.join("|")}>`],
    );
  if (!(groomStages as readonly string[]).includes(stage))
    return refuse("usage", `stage ${stage} is not one of ${groomStages.join(", ")}`, [
      `pass --stage as one of ${groomStages.join(", ")}`,
    ]);
  const proof = await prove(reader, {
    repo: input.repo,
    sha: input.sha,
    ref: input.ref,
    date: input.date,
    under: groom.proves.under,
    functions: input.functions,
    asserts: input.asserts,
    checks: input.checks,
    files: input.files,
    timeoutMs: input.timeoutMs,
  });
  const counters = countersOf(proof);
  const proposed = input.points === null;
  const points =
    input.points ?? defaultPoints(groom, input.files.length, counters.callers);
  const reason =
    input.reason ??
    `default_points: ${input.files.length} paths, ${counters.callers} callers`;
  const proved = provedLine(proof);
  const problem = checkProposal(groom, { points, proved });
  if (problem !== null) return { ok: false, refusal: problem };
  const size = groom.points_to_size[String(points)];
  if (size === undefined)
    return refuse("proposal_invalid", `points_to_size has no size for ${points}`, [
      "fix the groom Revision's points_to_size",
    ]);
  const kickoff = await kickoffOf(db, groom, stage, points, size);
  if (typeof kickoff !== "string") return kickoff;
  const body = proposalBody({
    stage,
    points,
    proposed,
    size,
    kickoff,
    reason,
    proved,
  });
  const opKey = derivedOpKey("groom", {
    provider: input.story.provider,
    external_id: input.story.external_id,
    groom_revision: active.id,
    stage,
    points: String(points),
    kickoff,
    reason,
    proved,
  });
  const payload = {
    story: input.story.external_id,
    provider: input.story.provider,
    groom_revision: active.id,
    stage,
    points,
    proposed,
    reason,
    size,
    kickoff,
    ref: proof.ref,
    sha: proof.sha,
    date: proof.date,
    counters,
    proved,
  };
  const now = input.now();
  const recorded = await db.transaction(async (tx) => {
    const inserted = await tx.insertOperation({
      op_key: opKey,
      intent: "groom",
      owner_generation: 0,
      at: now,
      result_ref: { request: Json.parse(payload) },
    });
    if (!inserted.created) return false;
    await tx.appendEvent({
      type: "groom_proved",
      ts: now,
      host: input.host,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse(payload),
      source: { kind: "command", verb: "groom", actor: input.actor },
    });
    await tx.enqueueOutbox({
      op_key: opKey,
      target: "tracker",
      payload: { kind: "estimate", story: input.story, points },
    });
    await tx.enqueueOutbox({
      op_key: opKey,
      target: "tracker",
      payload: commentPayload(input.story, body),
    });
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request: payload }),
      now,
    );
    return true;
  });
  const drained = await drainOutbox(db, tracker, log, {
    run_id: null,
    generation: 0,
    host: input.host,
    now: input.now,
    op_keys: [opKey],
  });
  if (await unconfirmed(db, opKey, drained.failed.length))
    return refuse(
      "tracker_unconfirmed",
      `the tracker has not acked the groom proposal for story:${input.story.external_id}: ${drained.failed.map((row) => row.error).join(", ") || "parked"}`,
      [input.command],
    );
  return {
    ok: true,
    result: {
      story: {
        provider: input.story.provider,
        external_id: input.story.external_id,
        title: story.title,
      },
      stage,
      points,
      proposed,
      reason,
      size,
      kickoff,
      groom_revision: active.id,
      ref: proof.ref,
      sha: proof.sha,
      date: proof.date,
      counters,
      sites: proof.sites,
      asserting: proof.asserting,
      helpers: proof.helpers,
      checks: proof.checks,
      paths: proof.paths,
      proved,
      body,
      op_key: opKey,
      recorded,
      delivered: {
        acked: drained.acked.length,
        failed: drained.failed.length,
      },
    },
  };
}
