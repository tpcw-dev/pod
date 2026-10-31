import { z } from "zod";
import { noSingleActive } from "../config/active.ts";
import type { BriefRun, BriefTree } from "../domain/brief.ts";
import type { Revision } from "../domain/config.ts";
import type { DecisionScope } from "../domain/decision.ts";
import type { GateReceipt, Task } from "../domain/ledger.ts";
import { HoldPayload } from "../domain/hold.ts";
import type {
  DecisionsSection,
  LearningsSection,
  NeedsHumanSection,
  PoliciesSection,
  RoadmapSection,
  RunsSection,
  StateScope,
  UsageSection,
} from "../domain/state.ts";
import { gateOf } from "../gate/receipt.ts";
import type { Repo } from "../ports/db.ts";
import type { DocsPort, Section } from "../ports/docs.ts";
import { ProcessValue, type Step } from "../process/schema.ts";
import { waitingOn } from "../process/waiting.ts";
import { applicableDecisions } from "./decisions.ts";

export interface StateContext {
  repo: Repo;
  docs: DocsPort | null;
  now: () => Date;
}

export interface WithRouting<T> {
  section: T;
  routing: string[];
}

const Fields = z.record(z.string(), z.unknown());
const satisfied = new Set(["passed", "done"]);
const listed = new Set(["active", "hold"]);

function observed(ctx: StateContext): string {
  return ctx.now().toISOString();
}

function sectionLines(section: Section): string[] {
  return [
    ...section.paragraphs,
    ...section.tables.flatMap((table) =>
      table.rows.map((row) => row.join(" | ")),
    ),
  ]
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isCurrent(line: string, current: string | undefined): boolean {
  if (current === undefined) return false;
  return line === current || line.split(" | ")[0]?.trim() === current;
}

async function readHeading(
  docs: DocsPort,
  page: string,
  heading: string,
): Promise<{ section: Section } | { error: string }> {
  try {
    const read = await docs.readSection({ page, heading });
    if (read.ok && read.result !== null) return { section: read.result };
    return { error: `${heading}: ${read.error ?? "no result"}` };
  } catch (error) {
    return {
      error: `${heading}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function roadmapSection(
  ctx: StateContext,
  policy: Revision | null,
  scope: StateScope,
): Promise<WithRouting<RoadmapSection>> {
  const source_revision = policy?.id ?? null;
  const notOk = (
    status: "no_docs_port" | "no_policy" | "no_roadmap" | "read_failed",
    detail: string,
    routing: string,
  ): WithRouting<RoadmapSection> => ({
    section: { status, detail, source_revision, observed_at: observed(ctx) },
    routing: [routing],
  });
  if (ctx.docs === null)
    return notOk(
      "no_docs_port",
      "this host has no docs token and no docs fixtures",
      "set the docs token or POD_DOCS_FIXTURES to read the roadmap",
    );
  if (policy === null) {
    const refused =
      scope.project === null
        ? noSingleActive("policy", "global", "")
        : noSingleActive("policy", "project", scope.project);
    return notOk(
      "no_policy",
      refused.refusal.message,
      refused.refusal.nextSteps[0] ?? "pod config apply",
    );
  }
  const roadmap = Fields.safeParse(
    Fields.safeParse(policy.value).data?.["roadmap"],
  );
  const page = roadmap.data?.["page"];
  if (typeof page !== "string" || page.trim() === "")
    return notOk(
      "no_roadmap",
      `policy ${policy.name}@${policy.rev} has no roadmap`,
      "set roadmap { provider, page } in the active policy",
    );
  const failed = (error: string, heading: string) =>
    notOk(
      "read_failed",
      error,
      `pod docs read --page ${page} --heading ${heading}`,
    );
  const current = await readHeading(ctx.docs, page, "Current milestone");
  if ("error" in current) return failed(current.error, "Current milestone");
  const milestones = await readHeading(ctx.docs, page, "Milestones");
  if ("error" in milestones) return failed(milestones.error, "Milestones");
  const currentLines = sectionLines(current.section);
  const name = currentLines[0]?.split(" | ")[0]?.trim();
  return {
    section: {
      status: "ok",
      page,
      current: currentLines,
      milestones: sectionLines(milestones.section).map((text) => ({
        text,
        current: isCurrent(text, name),
      })),
      source_revision,
      observed_at: observed(ctx),
    },
    routing: [],
  };
}

function stepOf(process: Revision | null, task: Task): Step | null {
  if (process === null) return null;
  const parsed = ProcessValue.safeParse(process.value);
  if (!parsed.success) return null;
  return parsed.data.steps.find((step) => step.id === task.step_id) ?? null;
}

function liveReceipt(
  receipts: readonly GateReceipt[],
  task: Task,
  gate: string,
): GateReceipt | null {
  const live = receipts.filter(
    (row) =>
      row.task_id === task.task_id &&
      row.gate_id === gate &&
      row.sync_state !== "voided",
  );
  return live.at(-1) ?? null;
}

async function taskWaiting(
  ctx: StateContext,
  run: BriefRun,
  task: Task,
  receipts: readonly GateReceipt[],
): Promise<string | null> {
  const states = new Map(run.tasks.map((row) => [row.task_id, row.state]));
  switch (task.state) {
    case "ready":
      return "dispatch";
    case "dispatched":
      return "delivery";
    case "blocked":
      return "retry";
    case "hold": {
      const event = await ctx.repo.latestEvent(run.run.run_id, "hold", {
        taskId: task.task_id,
      });
      const payload = HoldPayload.safeParse(event?.payload);
      return payload.success ? `hold ${payload.data.reason}` : "hold";
    }
    case "pending": {
      const deps = z.array(z.string()).safeParse(task.deps);
      const open = deps.success
        ? deps.data.filter((id) => !satisfied.has(states.get(id) ?? ""))
        : [];
      return ["needs", ...open].join(" ");
    }
    case "delivered": {
      const process = run.snapshot?.process ?? null;
      const step = stepOf(process, task);
      if (step?.gate === undefined || step.decision !== undefined)
        return waitingOn(
          process,
          task,
          run.decisions.find((row) => row.task_id === task.task_id),
        );
      if (liveReceipt(receipts, task, step.gate) !== null) return null;
      const keeper = gateOf(run.snapshot?.policy?.value, step.gate);
      return keeper === null
        ? `gate ${step.gate}`
        : `gate ${step.gate} keeper ${keeper.keeper}`;
    }
    default:
      return null;
  }
}

export async function runsSection(
  ctx: StateContext,
  tree: BriefTree,
): Promise<RunsSection> {
  const runs: RunsSection["runs"] = [];
  for (const story of tree.stories)
    for (const run of story.runs) {
      if (!listed.has(run.run.state)) continue;
      const receipts = await ctx.repo.listGateReceipts(run.run.run_id);
      const waiting_on: string[] = [];
      for (const task of run.tasks) {
        const line = await taskWaiting(ctx, run, task, receipts);
        if (line !== null) waiting_on.push(`${task.task_id} ${line}`);
      }
      runs.push({
        run_id: run.run.run_id,
        story: story.story.external_id,
        state: run.run.state,
        source_revision: run.snapshot?.process_revision_id ?? null,
        waiting_on,
      });
    }
  return { runs, source_revision: null, observed_at: observed(ctx) };
}

function strings(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  const fields = Fields.safeParse(value);
  if (!fields.success) return [];
  return Object.entries(fields.data).map(
    ([key, item]) =>
      `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`,
  );
}

function revisionRef(revision: Revision | null) {
  return revision === null
    ? null
    : { id: revision.id, name: revision.name, rev: revision.rev };
}

export function policiesSection(
  ctx: StateContext,
  policy: Revision | null,
  crew: Revision | null,
): PoliciesSection {
  const reserved = Fields.safeParse(
    Fields.safeParse(policy?.value).data?.["reserved"],
  ).data;
  return {
    policy: revisionRef(policy),
    crew: revisionRef(crew),
    reserved: {
      deny: strings(reserved?.["deny"]),
      needs_human: strings(reserved?.["needs_human"]),
      needs_existing_authorization: strings(
        reserved?.["needs_existing_authorization"],
      ),
    },
    source_revision: policy?.id ?? null,
    observed_at: observed(ctx),
  };
}

function scopeText(scope: DecisionScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.ref}`;
}

export async function decisionsSection(
  ctx: StateContext,
  scope: StateScope,
): Promise<DecisionsSection> {
  const decisions = applicableDecisions(
    await ctx.repo.listDecisions(scope),
    scope,
    ctx.now(),
  );
  return {
    decisions: decisions.map((row) => ({
      id: row.id,
      scope: scopeText(row.scope),
      question: row.question,
      outcome: row.outcome,
      decided_at: row.decided_at.toISOString(),
      in_force_until: row.in_force_until?.toISOString() ?? null,
      standing: row.standing,
    })),
    source_revision: null,
    observed_at: observed(ctx),
  };
}

export async function usageSection(
  ctx: StateContext,
  providers: readonly string[],
): Promise<UsageSection> {
  const latest = new Map(
    (await ctx.repo.latestUsageObservations(providers)).map((row) => [
      row.provider,
      row,
    ]),
  );
  return {
    providers: providers.map((provider) => {
      const row = latest.get(provider);
      const known = row !== undefined && row.coverage !== "no_source";
      return {
        provider,
        value: known && row.value !== null ? row.value : "unknown",
        coverage: row?.coverage ?? "no_source",
        observed_at: row?.observed_at.toISOString() ?? null,
      };
    }),
    source_revision: null,
    observed_at: observed(ctx),
  };
}

export async function needsHumanSection(
  ctx: StateContext,
  tree: BriefTree,
): Promise<NeedsHumanSection> {
  const open: NeedsHumanSection["items"] = [];
  const closed: NeedsHumanSection["items"] = [];
  for (const story of tree.stories)
    for (const run of story.runs) {
      for (const decision of await ctx.repo.listRunDecisions(run.run.run_id))
        if (decision.state === "needs_human")
          open.push({
            story: story.story.external_id,
            run_id: run.run.run_id,
            task_id: decision.task_id ?? "",
            gate: `decision ${decision.id}`,
            keeper: "operator",
            open: true,
            reason: `decision needs_human: ${decision.reason ?? "unknown"}`,
            at: (decision.closed_at ?? decision.created_at).toISOString(),
          });
      const policy = run.snapshot?.policy ?? null;
      if (policy === null) continue;
      const receipts = await ctx.repo.listGateReceipts(run.run.run_id);
      for (const task of run.tasks) {
        const gate = stepOf(run.snapshot?.process ?? null, task)?.gate;
        if (gate === undefined) continue;
        const keeper = gateOf(policy.value, gate);
        if (keeper?.type !== "HQA") continue;
        const base = {
          story: story.story.external_id,
          run_id: run.run.run_id,
          task_id: task.task_id,
          gate,
          keeper: keeper.keeper,
        };
        const receipt = liveReceipt(receipts, task, gate);
        if (receipt !== null)
          closed.push({
            ...base,
            open: false,
            reason: `${receipt.outcome} recorded`,
            at: receipt.created_at.toISOString(),
          });
        else if (task.state === "delivered")
          open.push({
            ...base,
            open: true,
            reason: `awaiting ${gate} PASS or FAIL from ${keeper.keeper}`,
            at: task.created_at.toISOString(),
          });
      }
    }
  closed.sort((a, b) => b.at.localeCompare(a.at));
  return {
    items: [...open, ...closed],
    source_revision: null,
    observed_at: observed(ctx),
  };
}

export async function learningsSection(
  ctx: StateContext,
  scope: StateScope,
): Promise<LearningsSection> {
  const rows = await ctx.repo.listLearnings({
    adoption: "adopted",
    ...(scope.project === null ? {} : { project: scope.project }),
  });
  return {
    learnings: rows.map((row) => ({
      id: row.id,
      text: row.text,
      area: row.area,
      source_story: row.source_story,
      created_at: row.created_at.toISOString(),
    })),
    source_revision: null,
    observed_at: observed(ctx),
  };
}
