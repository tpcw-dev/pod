import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { endHostDrain, HostDrainResult } from "../core/run/attention-pause.ts";
import { drain, DrainResult } from "../core/run/drain.ts";
import { singleActive } from "../core/config/active.ts";
import { hostCapacity } from "../core/plan/capacity.ts";
import { takeover } from "../core/run/takeover.ts";
import { databaseUrl, podHome, readHostProfile } from "./host-profile.ts";
import { actorOf, needsPerson, writerOf } from "./identity.ts";
import { quote } from "../core/domain/shell.ts";
import { Generation, withOrca } from "./run-verbs.ts";

export const DrainInput = z
  .strictObject({
    args: z.tuple([]),
    run: z.string().min(1).optional(),
    generation: Generation.optional(),
    end: z.boolean().optional(),
    "op-key": z.string().min(1).optional(),
  })
  .refine(
    (input) =>
      input.run !== undefined && input.generation !== undefined
        ? true
        : input.run === undefined &&
          input.generation === undefined &&
          input["op-key"] === undefined &&
          input.end === true,
    "pass --run and --generation for a Run, or --end alone to end the host pause",
  );
type DrainInput = z.infer<typeof DrainInput>;

export const DrainOutput = z.union([
  DrainResult.extend({ op_key: z.string() }),
  HostDrainResult.extend({ op_key: z.string() }),
]);
type DrainOutput = z.infer<typeof DrainOutput>;

const hostGo = {
  what: "ending the host attention pause",
  nextSteps: ["Run pod drain --end from the operator's shell"],
};

export async function drainVerb(input: DrainInput): Promise<DrainOutput> {
  const { run, generation } = input;
  if (run === undefined || generation === undefined) {
    const host = readHostProfile();
    const connection = connect(databaseUrl(host));
    try {
      const identity = await writerOf(connection.db, host, process.env, hostGo);
      needsPerson(identity, hostGo);
      const { result, opKey } = await endHostDrain(connection.db, {
        host: host.hostId,
        actor: actorOf(identity),
        now: new Date(),
      });
      return { ...result, op_key: opKey };
    } finally {
      await connection.close();
    }
  }
  const { result, opKey } = await withOrca(({ db, host }) =>
    drain(db, {
      run,
      generation: Number(generation),
      end: input.end === true,
      opKey: input["op-key"] ?? null,
      host: host.hostId,
      now: () => new Date(),
    }),
  );
  return { ...result, op_key: opKey };
}

export function drainMeta(output: DrainOutput) {
  return "owner_generation" in output
    ? { ownerGeneration: output.owner_generation, opKey: output.op_key }
    : { opKey: output.op_key };
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
  coordinator_dispatch_id: z.string().nullable(),
  seat_refusal: z
    .object({
      role: z.string(),
      code: z.string(),
      message: z.string(),
      nextSteps: z.array(z.string()),
    })
    .optional(),
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
  const coordinator = process.env["POD_COORDINATOR"] ?? "";
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
    async ({ db, orca: port, log, host, kinds }) =>
      takeover(db, port, log, {
        story: story.slice("story:".length),
        provider: kinds.trackerKind,
        generation: Number(input.generation),
        coordinator,
        opKey: input["op-key"] ?? null,
        viewPath: (runId, generation) =>
          input.out ??
          join(podHome(), "restore", `${runId}-${generation}.html`),
        host: host.hostId,
        seats: {
          templates: await singleActive(db, "decision", "global", ""),
          capacity: await hostCapacity(db, host.hostId, new Date()),
        },
        command,
        now: () => new Date(),
      }),
  );
  mkdirSync(dirname(result.view_path), { recursive: true });
  writeFileSync(result.view_path, result.restore_view);
  return { ...result, op_key: opKey, orca };
}
