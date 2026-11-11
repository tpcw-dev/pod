import { readFileSync } from "node:fs";
import { z } from "zod";
import { recordDeploy } from "../core/deploy/record.ts";
import { Deploy } from "../core/domain/delivery.ts";
import { schemaError, usageError } from "./errors.ts";
import { gitTree } from "./git.ts";
import { Generation, withOrca } from "./run-verbs.ts";
import { issuesOf, readText } from "./yaml-file.ts";

const Story = z.string().regex(/^story:.+$/);

export const DeployRecordInput = z.strictObject({
  args: z.union([z.tuple([Story]), z.tuple([Story, z.string().min(1)])]),
  generation: Generation,
  stdin: z.boolean().optional(),
});
type DeployRecordInput = z.infer<typeof DeployRecordInput>;

export const DeployRecordOutput = z.object({
  run_id: z.string(),
  task_id: z.string(),
  state: z.string(),
  deployed_revision: z.string(),
  op_key: z.string(),
  replayed: z.boolean(),
  owner_generation: z.int(),
});
type DeployRecordOutput = z.infer<typeof DeployRecordOutput>;

export function deployMeta(output: DeployRecordOutput) {
  return { ownerGeneration: output.owner_generation, opKey: output.op_key };
}

function readLine(path: string | undefined, stdin: boolean): Deploy {
  if ((path === undefined) === !stdin)
    throw usageError("pod deploy record takes FILE or --stdin, not both");
  const source = path ?? "stdin";
  const text = (
    path === undefined ? readFileSync(0, "utf8") : readText(path)
  ).trim();
  if (text === "" || text.includes("\n"))
    throw schemaError(`${source} is not one JSON line`, [
      "pass the one line pnpm deploy:local prints",
    ]);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw schemaError(`${source} is not JSON`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const parsed = Deploy.safeParse(value);
  if (!parsed.success)
    throw schemaError(
      `${source} fails the deploy line schema`,
      issuesOf(parsed.error),
    );
  return parsed.data;
}

export async function deployRecordVerb(
  input: DeployRecordInput,
): Promise<DeployRecordOutput> {
  const [story, path] = input.args;
  const line = readLine(path, input.stdin === true);
  const generation = Number(input.generation);
  const { result } = await withOrca(({ db, host, kinds }) =>
    recordDeploy(db, {
      story: {
        provider: kinds.trackerKind,
        external_id: story.slice("story:".length),
      },
      generation,
      line,
      host: host.hostId,
      treeOf: gitTree,
      now: () => new Date(),
    }),
  );
  return { ...result, owner_generation: generation };
}
