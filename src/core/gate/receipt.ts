import { createHash } from "node:crypto";
import { z } from "zod";
import type { Repo } from "../ports/db.ts";
import type { TrackerComment } from "../ports/tracker.ts";
import type { BypassResult } from "./bypass.ts";

export function shaMatches(given: string, candidate: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(given) && candidate.startsWith(given);
}

export function contentHash(body: string): string {
  return createHash("sha256")
    .update(body.replaceAll("\r\n", "\n").trimEnd(), "utf8")
    .digest("hex");
}

const PushPayload = z.looseObject({ sha: z.string() });

export async function candidateSha(
  tx: Repo,
  runId: string,
): Promise<string | null> {
  const push = await tx.latestEvent(runId, "push");
  return PushPayload.safeParse(push?.payload).data?.sha ?? null;
}

type Verdict = "PASS" | "FAIL";

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findVerdictComment(
  comments: readonly TrackerComment[],
  gateId: string,
): { comment: TrackerComment; outcome: Verdict } | null {
  const form = new RegExp(
    `^(?:[A-Za-z][\\w-]*:\\s*)?${escaped(gateId)} (PASS|FAIL)$`,
  );
  for (const comment of comments) {
    const first = comment.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    const match = first === undefined ? null : form.exec(first);
    if (match?.[1] === "PASS" || match?.[1] === "FAIL")
      return { comment, outcome: match[1] };
  }
  return null;
}

function relayTrailer(
  body: string,
): { session: string; rest: string } | null {
  const lines = body.replaceAll("\r\n", "\n").trimEnd().split("\n");
  const last = lines.at(-1) ?? "";
  const match = /^relayed-by: (\S+)\s*$/.exec(last);
  if (match?.[1] === undefined) return null;
  return { session: match[1], rest: lines.slice(0, -1).join("\n") };
}

export type Principals = Record<string, { tracker_account: string }>;

const Principal = z.looseObject({ tracker_account: z.string().min(1) });
const Fields = z.record(z.string(), z.unknown());

export function principalsOf(policy: unknown): Principals {
  const value = Fields.safeParse(policy).data ?? {};
  const listed = Fields.safeParse(value["principals"]).data ?? {};
  const principals: Principals = {};
  for (const [name, entry] of Object.entries(listed)) {
    const parsed = Principal.safeParse(entry);
    if (parsed.success)
      principals[name] = { tracker_account: parsed.data.tracker_account };
  }
  return principals;
}

export interface GateKeeper {
  keeper: string;
  type: "AQA" | "HQA";
}

const GateEntry = z.looseObject({
  keeper: z.string().min(1),
  type: z.enum(["AQA", "HQA"]),
});

export function gateOf(policy: unknown, gateId: string): GateKeeper | null {
  const gates = (Fields.safeParse(policy).data ?? {})["gates"];
  const entry = Array.isArray(gates)
    ? gates.find((row) => Fields.safeParse(row).data?.["id"] === gateId)
    : Fields.safeParse(gates).data?.[gateId];
  const parsed = GateEntry.safeParse(entry);
  return parsed.success
    ? { keeper: parsed.data.keeper, type: parsed.data.type }
    : null;
}

const relayPrincipal = "relay";

export type SourceRefusal =
  | "bypass_missing"
  | "bypass_failed"
  | "no_author"
  | "relay_without_trailer"
  | "not_a_human_source";

export type SourceCheck =
  | { ok: true; relayed_by: string | null; content_hash: string }
  | { ok: false; reason: SourceRefusal };

export function verifySource(
  comment: TrackerComment,
  principals: Principals,
  keeper: string,
  bypass: BypassResult | null,
): SourceCheck {
  if (bypass === null) return { ok: false, reason: "bypass_missing" };
  if (bypass.result !== "pass") return { ok: false, reason: "bypass_failed" };
  const author = comment.authorId;
  if (author === null) return { ok: false, reason: "no_author" };
  if (author === principals[keeper]?.tracker_account)
    return {
      ok: true,
      relayed_by: null,
      content_hash: contentHash(comment.body),
    };
  if (author === principals[relayPrincipal]?.tracker_account) {
    const trailer = relayTrailer(comment.body);
    if (trailer === null) return { ok: false, reason: "relay_without_trailer" };
    return {
      ok: true,
      relayed_by: trailer.session,
      content_hash: contentHash(trailer.rest),
    };
  }
  return { ok: false, reason: "not_a_human_source" };
}

export function hashOf(body: string, relayedBy: string | null): string {
  const trailer = relayedBy === null ? null : relayTrailer(body);
  return contentHash(trailer?.rest ?? body);
}

interface Pinned {
  policy: unknown;
  crew: unknown;
}

export async function pinnedConfig(
  tx: Repo,
  runId: string,
): Promise<Pinned | null> {
  const snapshot = await tx.getSnapshot(runId);
  if (snapshot === null) return null;
  const policy = await tx.getRevision(snapshot.policy_revision_id);
  const crew = await tx.getRevision(snapshot.crew_revision_id);
  if (policy === null || crew === null) return null;
  return { policy: policy.value, crew: crew.value };
}
