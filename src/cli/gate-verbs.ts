import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HqaAmbiguous, recordHqa } from "../core/gate/hqa.ts";
import { postVerdict, VerdictFile } from "../core/gate/verdict.ts";
import { schemaError, usageError } from "./errors.ts";
import { podHome } from "./host-profile.ts";
import { Generation, quote, withOrca } from "./run-verbs.ts";
import { issuesOf, parseYaml, readText } from "./yaml-file.ts";

const Outcome = z.object({
  task_id: z.string(),
  outcome: z.string(),
  state: z.string(),
  promoted: z.array(z.string()),
  created: z.array(z.string()),
  replayed: z.boolean(),
});

export const VerdictPostInput = z.strictObject({
  args: z.tuple([z.string().min(1)]),
  generation: Generation,
});
type VerdictPostInput = z.infer<typeof VerdictPostInput>;

export const VerdictPostOutput = Outcome.extend({
  receipt_id: z.number(),
  op_key: z.string(),
  gate: z.string(),
  candidate_sha: z.string(),
  owner_generation: z.int(),
  orca: z.string(),
});
type VerdictPostOutput = z.infer<typeof VerdictPostOutput>;

export function gateMeta(output: {
  owner_generation: number;
  op_key: string | null;
  orca: string;
}) {
  return {
    ownerGeneration: output.owner_generation,
    ...(output.op_key === null ? {} : { opKey: output.op_key }),
    orca: output.orca,
  };
}

function readVerdictFile(path: string): VerdictFile {
  const parsed = VerdictFile.safeParse(parseYaml(readText(path), path));
  if (!parsed.success)
    throw schemaError(
      `${path} fails the verdict file schema`,
      issuesOf(parsed.error),
    );
  return parsed.data;
}

export async function verdictPostVerb(
  input: VerdictPostInput,
): Promise<VerdictPostOutput> {
  const [path] = input.args;
  const file = readVerdictFile(path);
  const generation = Number(input.generation);
  const { result, orca } = await withOrca(({ db, orca: port, log, host }) =>
    postVerdict(db, port, log, {
      file,
      generation,
      host: host.hostId,
      command: `pod verdict post ${quote(path)} --generation ${generation}`,
      now: () => new Date(),
    }),
  );
  return { ...result, owner_generation: generation, orca };
}

export const HqaRecordInput = z.strictObject({
  args: z.tuple([z.string().regex(/^story:.+$/)]),
  generation: Generation,
});
type HqaRecordInput = z.infer<typeof HqaRecordInput>;

export const HqaRecordOutput = z.object({
  run_id: z.string(),
  gate: z.string().nullable(),
  receipt_id: z.number().nullable(),
  op_key: z.string().nullable(),
  outcome: Outcome.nullable(),
  nextSteps: z.array(z.string()),
  owner_generation: z.int(),
  orca: z.string(),
});
type HqaRecordOutput = z.infer<typeof HqaRecordOutput>;

export async function hqaRecordVerb(
  input: HqaRecordInput,
): Promise<HqaRecordOutput> {
  const [story] = input.args;
  const externalId = story.slice("story:".length);
  const generation = Number(input.generation);
  const { result, orca } = await withOrca(
    async ({ db, orca: port, tracker, log, host }) => {
      if (tracker === null)
        throw usageError(`pod hqa record needs ${host.trackerTokenEnv}`, [
          `set ${host.trackerTokenEnv} to the tracker token`,
        ]);
      try {
        return await recordHqa(db, port, tracker, log, {
          story: { provider: host.trackerKind, external_id: externalId },
          generation,
          host: host.hostId,
          hostName: hostname(),
          bypassPath: join(podHome(), "bypass.jsonl"),
          command: `pod hqa record ${story} --generation ${generation}`,
          now: () => new Date(),
        });
      } catch (error) {
        if (error instanceof HqaAmbiguous)
          throw usageError(error.message, [
            "record one HQA gate at a time; settle the other Task first",
          ]);
        throw error;
      }
    },
  );
  return { ...result, owner_generation: generation, orca };
}
