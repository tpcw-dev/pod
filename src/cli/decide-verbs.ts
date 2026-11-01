import { z } from "zod";
import { singleActive } from "../core/config/active.ts";
import { revisionId } from "../core/config/canonical-json.ts";
import { decisionLimits } from "../core/config/limits.ts";
import { fence, StaleGeneration } from "../core/check/fence.ts";
import { cancelDecision } from "../core/decide/advance.ts";
import { openDecision } from "../core/decide/open.ts";
import { rulingText, rulingVerbs } from "../core/decide/ruling.ts";
import type { NewRevision } from "../core/domain/config.ts";
import { DecisionEffect } from "../core/domain/decision.ts";
import type { Task } from "../core/domain/ledger.ts";
import { exitFor, PodError, schemaError, usageError } from "./errors.ts";
import { withOrca } from "./run-verbs.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

export const DecideInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  task: z.string().min(1),
  category: z.string().min(1),
  effect: z.string().min(1),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  "op-key": z.string().min(1).optional(),
  supersedes: z.string().min(1).optional(),
});
type DecideInput = z.infer<typeof DecideInput>;

export const DecideOutput = z.object({
  decision_id: z.string(),
  run_id: z.string(),
  task_id: z.string(),
  state: z.string(),
  manifest_id: z.string(),
  decider_dispatch_id: z.string(),
  round: z.int(),
  reserved: z.object({ class: z.string(), member: z.string() }).nullable(),
  op_key: z.string(),
  orca: z.string(),
});
type DecideOutput = z.infer<typeof DecideOutput>;

const TaskSpecFile = z.strictObject({
  kind: z.literal("task"),
  schema_version: z.int().positive(),
  spec: z.string().trim().min(1),
});
type TaskSpecFile = z.infer<typeof TaskSpecFile>;

const Question = z.strictObject({
  question: z.string().trim().min(1),
  options: z.array(z.string().min(1)).min(1),
  spec: TaskSpecFile.optional(),
});

function specRevision(
  task: Task | null,
  file: TaskSpecFile,
): NewRevision | null {
  if (task === null) return null;
  const envelope = {
    kind: "task" as const,
    name: task.lineage_id,
    schema_version: file.schema_version,
    scope: "run" as const,
    scope_ref: task.run_id,
    parent: null,
    value: { spec: file.spec },
  };
  return {
    ...envelope,
    id: revisionId(envelope),
    actor: "pod decide",
    reason: "pod decide --effect change_spec",
  };
}

export async function decideVerb(input: DecideInput): Promise<DecideOutput> {
  const effect = DecisionEffect.safeParse(input.effect);
  if (!effect.success)
    throw usageError(
      `--effect ${input.effect} is not accept_plan or change_spec`,
      ["pod decide --effect accept_plan", "pod decide --effect change_spec"],
    );
  const [file] = input.args;
  const parsed = Question.safeParse(parseYaml(readText(file), file));
  if (!parsed.success)
    throw schemaError(
      `${file} fails the decision question schema`,
      issuesOf(parsed.error),
    );
  const { spec } = parsed.data;
  if (effect.data === "change_spec" && spec === undefined)
    throw usageError(
      `${file} has no spec; --effect change_spec needs a Task spec`,
      ["spec"],
    );
  if (effect.data === "accept_plan" && input.supersedes !== undefined)
    throw usageError(
      `--supersedes ${input.supersedes} needs --effect change_spec`,
      ["pod decide --effect change_spec --supersedes <id>"],
    );
  if (effect.data === "accept_plan" && spec !== undefined)
    throw usageError(`${file} has a spec; --effect accept_plan takes none`, [
      "spec",
    ]);
  const { result, opKey, orca } = await withOrca(
    async ({ db, orca: port, log, host }) =>
      openDecision(db, port, log, {
        task: input.task,
        category: input.category,
        effect: effect.data,
        spec:
          spec === undefined
            ? null
            : specRevision(await db.getTask(input.task), spec),
        question: parsed.data.question,
        options: parsed.data.options,
        generation: Number(input.generation),
        opKey: input["op-key"] ?? null,
        supersedes: input.supersedes ?? null,
        host: host.hostId,
        capacity: host.capacity,
        templates: await singleActive(db, "decision", "global", ""),
        limits: decisionLimits,
        now: () => new Date(),
      }),
  );
  return { ...result, op_key: opKey, orca };
}

export const DecideRulingInput = z.strictObject({
  args: z.tuple([z.string().min(1), z.enum(rulingVerbs)]),
  note: z.string().trim().min(1).optional(),
  json: z.boolean().optional(),
});
type DecideRulingInput = z.infer<typeof DecideRulingInput>;

export const DecideRulingOutput = z.object({ text: z.string() });
type DecideRulingOutput = z.infer<typeof DecideRulingOutput>;

export function decideRulingVerb(
  input: DecideRulingInput,
): Promise<DecideRulingOutput> {
  const [decision, verb] = input.args;
  return Promise.resolve({
    text: rulingText({
      decision_id: decision,
      verb,
      note: input.note ?? null,
    }),
  });
}

export function renderRuling(output: DecideRulingOutput): string {
  return output.text;
}

export const DecideCancelInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  generation: z.string().regex(/^[1-9][0-9]*$/),
});
type DecideCancelInput = z.infer<typeof DecideCancelInput>;

export const DecideCancelOutput = z.object({
  decision_id: z.string(),
  state: z.string(),
  owner_generation: z.int(),
});
type DecideCancelOutput = z.infer<typeof DecideCancelOutput>;

export async function decideCancelVerb(
  input: DecideCancelInput,
): Promise<DecideCancelOutput> {
  const [id] = input.args;
  const generation = Number(input.generation);
  const { result } = await withOrca(async ({ db, host }) => {
    const decision = await db.getDecision(id);
    if (decision === null)
      throw usageError(`no Decision ${id}`, ["pod state --decisions"]);
    const cancelled = await db
      .transaction(async (tx) => {
        await fence(tx, decision.run_id, generation);
        return cancelDecision(tx, {
          decision: id,
          at: new Date(),
          host: host.hostId,
          verb: "decide cancel",
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof StaleGeneration)) throw error;
        throw new PodError(
          "owner_generation_stale",
          exitFor("owner_generation_stale"),
          `--generation ${generation} differs from the Run's owner generation ${error.run.owner_generation}`,
          [
            `pod takeover story:${error.run.story_external_id} if this session should own the Run`,
          ],
        );
      });
    if (!cancelled.cancelled)
      throw usageError(
        `Decision ${id} is ${decision.state}; pod decide cancel applies to an open Decision`,
        [
          `a needs_human Decision leaves only on a ruling: pod decide ruling ${id} cancelled`,
        ],
      );
    return {
      ok: true as const,
      result: {
        decision_id: id,
        state: "cancelled",
        owner_generation: generation,
      },
    };
  });
  return result;
}
