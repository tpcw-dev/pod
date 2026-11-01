import { z } from "zod";
import { singleActive } from "../core/config/active.ts";
import { revisionId } from "../core/config/canonical-json.ts";
import { decisionLimits } from "../core/config/limits.ts";
import { openDecision } from "../core/decide/open.ts";
import type { NewRevision } from "../core/domain/config.ts";
import { DecisionEffect } from "../core/domain/decision.ts";
import type { Task } from "../core/domain/ledger.ts";
import { schemaError, usageError } from "./errors.ts";
import { withOrca } from "./run-verbs.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

export const DecideInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  task: z.string().min(1),
  category: z.string().min(1),
  effect: z.string().min(1),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  "op-key": z.string().min(1).optional(),
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
        host: host.hostId,
        capacity: host.capacity,
        templates: await singleActive(db, "decision", "global", ""),
        limits: decisionLimits,
        now: () => new Date(),
      }),
  );
  return { ...result, op_key: opKey, orca };
}
