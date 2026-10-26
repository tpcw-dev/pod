import type { ZodType } from "zod";
import {
  ConfigApplyInput,
  ConfigApplyOutput,
  ConfigExportInput,
  ConfigExportOutput,
  configApply,
  configExport,
} from "./config-verbs.ts";
import { BriefInput, BriefOutput, brief } from "./brief.ts";
import { DbMigrateInput, DbMigrateOutput, dbMigrate } from "./db-verbs.ts";
import {
  CheckInput,
  checkMeta,
  CheckOutput,
  checkVerb,
  DispatchInput,
  DispatchOutput,
  dispatchVerb,
  ReleaseInput,
  ReleaseOutput,
  releaseVerb,
  RetryInput,
  RetryOutput,
  retryVerb,
  RunCreateInput,
  RunCreateOutput,
  runCreateVerb,
  runMeta,
} from "./run-verbs.ts";

export type VerbContext = Record<string, never>;

export interface VerbRow<I, O> {
  name: string;
  input: ZodType<I>;
  output: ZodType<O>;
  handler: (input: I, ctx: VerbContext) => Promise<O>;
  sideEffect: "none" | "config" | "ledger" | "orca" | "tracker";
  cancelBy: readonly ("operator" | "coordinator" | "nobody")[];
  evidenceRequired: readonly string[];
  meta?: (output: O) => Record<string, unknown>;
}

function row<I, O>(verb: VerbRow<I, O>): VerbRow<unknown, unknown> {
  const { meta, handler, ...rest } = verb;
  return {
    ...rest,
    handler: (input, ctx) => handler(verb.input.parse(input), ctx),
    ...(meta === undefined
      ? {}
      : { meta: (output: unknown) => meta(verb.output.parse(output)) }),
  };
}

export const verbs: readonly VerbRow<unknown, unknown>[] = [
  row({
    name: "brief",
    input: BriefInput,
    output: BriefOutput,
    handler: brief,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a Story whose external_id matches story:<id> when that argument is set",
    ],
  }),
  row({
    name: "config apply",
    input: ConfigApplyInput,
    output: ConfigApplyOutput,
    handler: configApply,
    sideEffect: "config",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a file that passes its schema, every Role filled and every gate id present when the kind is process, and `expected_revision` equal to the active Revision when `--activate` is set",
    ],
  }),
  row({
    name: "config export",
    input: ConfigExportInput,
    output: ConfigExportOutput,
    handler: configExport,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: ["a Revision named by kind.name@rev"],
  }),
  row({
    name: "db migrate",
    input: DbMigrateInput,
    output: DbMigrateOutput,
    handler: dbMigrate,
    sideEffect: "config",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a reachable database and a `db/migrations/` journal that matches the applied-migrations table",
    ],
  }),
  row({
    name: "run create",
    input: RunCreateInput,
    output: RunCreateOutput,
    handler: runCreateVerb,
    sideEffect: "orca",
    cancelBy: ["operator"],
    evidenceRequired: [
      "a groomed Story with a size and a stage, and exactly one selected process Revision",
    ],
    meta: runMeta,
  }),
  row({
    name: "dispatch",
    input: DispatchInput,
    output: DispatchOutput,
    handler: dispatchVerb,
    sideEffect: "orca",
    cancelBy: ["coordinator", "operator"],
    evidenceRequired: [
      'Task state `ready`, every dependency satisfied as "Task states" defines, a free quota slot, which on an xl Run counts the coordinator\'s slot as released by the dispatch transaction, an authorized Seat for the Role, reviewer independent of developer, no drain in force',
    ],
    meta: runMeta,
  }),
  row({
    name: "check",
    input: CheckInput,
    output: CheckOutput,
    handler: checkVerb,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "the delivery's `payload.dispatchId` matches a recorded Dispatch, and its owner generation matches the Run",
    ],
    meta: checkMeta,
  }),
  row({
    name: "retry",
    input: RetryInput,
    output: RetryOutput,
    handler: retryVerb,
    sideEffect: "orca",
    cancelBy: ["coordinator", "operator"],
    evidenceRequired: [
      "Task state `blocked`, the original placement in `ledger.dispatch`, the worktree `git status` in the task view",
    ],
    meta: runMeta,
  }),
  row({
    name: "release",
    input: ReleaseInput,
    output: ReleaseOutput,
    handler: releaseVerb,
    sideEffect: "orca",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "the Dispatch is settled or the caller gives a retain reason, and this host owns the terminal",
    ],
    meta: runMeta,
  }),
];
