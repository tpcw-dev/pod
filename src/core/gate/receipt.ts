import { createHash } from "node:crypto";
import { z } from "zod";
import type { Task } from "../domain/ledger.ts";
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

export type Verdict = "PASS" | "FAIL";

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function verdictComments(
  comments: readonly TrackerComment[],
  gateId: string,
): { comment: TrackerComment; outcome: Verdict }[] {
  const form = new RegExp(
    `^(?:[A-Za-z][\\w-]*:\\s*)?${escaped(gateId)} (PASS|FAIL)$`,
  );
  return comments.flatMap((comment) => {
    const first = comment.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    const match = first === undefined ? null : form.exec(first);
    return match?.[1] === "PASS" || match?.[1] === "FAIL"
      ? [{ comment, outcome: match[1] }]
      : [];
  });
}

export function findVerdictComment(
  comments: readonly TrackerComment[],
  gateId: string,
): { comment: TrackerComment; outcome: Verdict } | null {
  return verdictComments(comments, gateId)[0] ?? null;
}

function relayTrailer(body: string): { session: string; rest: string } | null {
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

export const GateEntry = z.looseObject({
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

export function hqaKeepers(policy: unknown): string[] {
  const gates = (Fields.safeParse(policy).data ?? {})["gates"];
  const entries = Array.isArray(gates)
    ? gates
    : Object.values(Fields.safeParse(gates).data ?? {});
  const keepers = new Set<string>();
  for (const entry of entries) {
    const parsed = GateEntry.safeParse(entry);
    if (parsed.success && parsed.data.type === "HQA")
      keepers.add(parsed.data.keeper);
  }
  return [...keepers];
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

export const delegateName = /^[a-z][a-z0-9-]*$/;
export const DelegateNames = z.array(z.string().regex(delegateName));

export function delegatesOf(policy: unknown): string[] {
  const listed = (Fields.safeParse(policy).data ?? {})["delegates"];
  return DelegateNames.safeParse(listed).data ?? [];
}

function nonEmptyLines(body: string): string[] {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

export function delegatedTrailer(body: string): { delegate: string } | null {
  const match = /^delegated-by: (\S+)\s*$/.exec(
    nonEmptyLines(body).at(-1) ?? "",
  );
  return match?.[1] === undefined ? null : { delegate: match[1] };
}

export type DelegateRefusal =
  | "delegate_author_not_keeper"
  | "delegate_not_listed"
  | "delegate_without_quote"
  | "quote_date_invalid"
  | "edited";

export type DelegateCheck =
  | { ok: true; delegate: string; keeper_quote: string; content_hash: string }
  | { ok: false; reason: DelegateRefusal; delegate: string };

const dayMs = 24 * 60 * 60 * 1000;

function quoteDateValid(date: string, readbackAt: Date): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.toISOString().slice(0, 10) !== date) return false;
  const readbackDay = Date.parse(
    `${readbackAt.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  return parsed.getTime() <= readbackDay + dayMs;
}

export function verifyDelegated(
  comment: TrackerComment,
  input: {
    principals: Principals;
    delegates: readonly string[];
    keeper: string;
    readbackAt: Date;
  },
): DelegateCheck | null {
  const trailer = delegatedTrailer(comment.body);
  if (trailer === null) return null;
  const { delegate } = trailer;
  const refused = (reason: DelegateRefusal): DelegateCheck => ({
    ok: false,
    reason,
    delegate,
  });
  const account = input.principals[input.keeper]?.tracker_account;
  if (comment.authorId === null || comment.authorId !== account)
    return refused("delegate_author_not_keeper");
  if (!input.delegates.includes(delegate))
    return refused("delegate_not_listed");
  const quote = (nonEmptyLines(comment.body).at(-2) ?? "").trim();
  const match = /^keeper-quote: (\d{4}-\d{2}-\d{2}) "(.*)"$/.exec(quote);
  if (match?.[1] === undefined || (match[2] ?? "").trim() === "")
    return refused("delegate_without_quote");
  if (!quoteDateValid(match[1], input.readbackAt))
    return refused("quote_date_invalid");
  if (comment.editedAt !== null) return refused("edited");
  return {
    ok: true,
    delegate,
    keeper_quote: quote,
    content_hash: contentHash(comment.body),
  };
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

export function decideStep(task: Pick<Task, "task_id">): string {
  return `pod decide --task ${task.task_id} --category C --effect accept_plan FILE --generation N`;
}
