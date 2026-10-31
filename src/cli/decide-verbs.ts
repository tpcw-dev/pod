import { z } from "zod";
import { singleActive } from "../core/config/active.ts";
import { decisionLimits } from "../core/config/limits.ts";
import { openDecision } from "../core/decide/open.ts";
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
  op_key: z.string(),
  orca: z.string(),
});
type DecideOutput = z.infer<typeof DecideOutput>;

const Question = z.strictObject({
  question: z.string().trim().min(1),
  options: z.array(z.string().min(1)).min(1),
});

export async function decideVerb(input: DecideInput): Promise<DecideOutput> {
  if (input.effect === "change_spec")
    throw usageError("--effect change_spec is S12b; this Pod takes accept_plan", [
      "pod decide --effect accept_plan",
    ]);
  if (input.effect !== "accept_plan")
    throw usageError(`--effect ${input.effect} is not accept_plan`, [
      "pod decide --effect accept_plan",
    ]);
  const [file] = input.args;
  const parsed = Question.safeParse(parseYaml(readText(file), file));
  if (!parsed.success)
    throw schemaError(`${file} fails the decision question schema`, issuesOf(parsed.error));
  const { result, opKey, orca } = await withOrca(
    async ({ db, orca: port, log, host }) =>
      openDecision(db, port, log, {
        task: input.task,
        category: input.category,
        effect: "accept_plan",
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
