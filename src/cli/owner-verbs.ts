import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { drain, DrainResult } from "../core/run/drain.ts";
import { takeover } from "../core/run/takeover.ts";
import { usageError } from "./errors.ts";
import { podHome } from "./host-profile.ts";
import { Generation, quote, withOrca } from "./run-verbs.ts";

export const DrainInput = z.strictObject({
  args: z.tuple([]),
  run: z.string().min(1),
  generation: Generation,
  end: z.boolean().optional(),
  "op-key": z.string().min(1).optional(),
});
type DrainInput = z.infer<typeof DrainInput>;

export const DrainOutput = DrainResult.extend({ op_key: z.string() });
type DrainOutput = z.infer<typeof DrainOutput>;

export async function drainVerb(input: DrainInput): Promise<DrainOutput> {
  const { result, opKey } = await withOrca(({ db, host }) =>
    drain(db, {
      run: input.run,
      generation: Number(input.generation),
      end: input.end === true,
      opKey: input["op-key"] ?? null,
      host: host.hostId,
      now: () => new Date(),
    }),
  );
  return { ...result, op_key: opKey };
}

export function drainMeta(output: DrainOutput) {
  return { ownerGeneration: output.owner_generation, opKey: output.op_key };
}

export const TakeoverInput = z.strictObject({
  args: z.tuple([z.string().regex(/^story:.+$/)]),
  generation: Generation,
  out: z.string().min(1).optional(),
  "op-key": z.string().min(1).optional(),
});
type TakeoverInput = z.infer<typeof TakeoverInput>;

export const TakeoverOutput = z.object({
  run_id: z.string(),
  story: z.string(),
  owner_generation: z.int(),
  coordinator: z.string(),
  previous_coordinator: z.string(),
  consumer_generation: z.int(),
  manifest_id: z.string(),
  view_path: z.string(),
  restore_view: z.string(),
  nextSteps: z.array(z.string()),
  op_key: z.string(),
  orca: z.string(),
});
type TakeoverOutput = z.infer<typeof TakeoverOutput>;

export async function takeoverVerb(
  input: TakeoverInput,
): Promise<TakeoverOutput> {
  const coordinator = process.env["POD_COORDINATOR"];
  if (coordinator === undefined || coordinator === "")
    throw usageError("POD_COORDINATOR is not set", [
      "set POD_COORDINATOR to the new coordinator's Orca terminal handle",
    ]);
  const [story] = input.args;
  const command = (opKey: string) =>
    [
      "pod",
      "takeover",
      story,
      "--generation",
      input.generation,
      ...(input.out === undefined ? [] : ["--out", input.out]),
      "--op-key",
      opKey,
    ]
      .map(quote)
      .join(" ");
  const { result, opKey, orca } = await withOrca(
    ({ db, orca: port, log, host }) =>
      takeover(db, port, log, {
        story: story.slice("story:".length),
        provider: host.trackerKind,
        generation: Number(input.generation),
        coordinator,
        opKey: input["op-key"] ?? null,
        viewPath: (runId, generation) =>
          input.out ??
          join(podHome(), "restore", `${runId}-${generation}.html`),
        host: host.hostId,
        command,
        now: () => new Date(),
      }),
  );
  mkdirSync(dirname(result.view_path), { recursive: true });
  writeFileSync(result.view_path, result.restore_view);
  return { ...result, op_key: opKey, orca };
}
