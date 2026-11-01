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
import {
  LearningAddInput,
  LearningAddOutput,
  LearningQueryInput,
  LearningQueryOutput,
  learningAdd,
  learningAddMeta,
  learningQuery,
} from "./learning-verbs.ts";
import {
  gateMeta,
  HqaRecordInput,
  HqaRecordOutput,
  hqaRecordVerb,
  VerdictPostInput,
  VerdictPostOutput,
  verdictPostVerb,
} from "./gate-verbs.ts";
import {
  DecideCancelInput,
  DecideCancelOutput,
  decideCancelVerb,
  DecideInput,
  DecideOutput,
  DecideRulingInput,
  DecideRulingOutput,
  decideRulingVerb,
  decideVerb,
  renderRuling,
} from "./decide-verbs.ts";
import { DbMigrateInput, DbMigrateOutput, dbMigrate } from "./db-verbs.ts";
import {
  DocsReadInput,
  DocsReadOutput,
  docsRead,
  renderSection,
} from "./docs-verbs.ts";
import { StateInput, StateOutput, stateVerb } from "./state-verbs.ts";
import { renderState } from "../core/state/render.ts";
import {
  DrainInput,
  drainMeta,
  DrainOutput,
  drainVerb,
  TakeoverInput,
  TakeoverOutput,
  takeoverVerb,
} from "./owner-verbs.ts";
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
  render?: (output: O) => string;
}

function row<I, O>(verb: VerbRow<I, O>): VerbRow<unknown, unknown> {
  const { meta, render, handler, ...rest } = verb;
  return {
    ...rest,
    handler: (input, ctx) => handler(verb.input.parse(input), ctx),
    ...(meta === undefined
      ? {}
      : { meta: (output: unknown) => meta(verb.output.parse(output)) }),
    ...(render === undefined
      ? {}
      : { render: (output: unknown) => render(verb.output.parse(output)) }),
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
    name: "state",
    input: StateInput,
    output: StateOutput,
    handler: stateVerb,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a Story whose external_id matches story:<id> when that argument is set",
    ],
    render: renderState,
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
    name: "docs read",
    input: DocsReadInput,
    output: DocsReadOutput,
    handler: docsRead,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
    render: renderSection,
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
    name: "decide",
    input: DecideInput,
    output: DecideOutput,
    handler: decideVerb,
    sideEffect: "orca",
    cancelBy: ["operator"],
    evidenceRequired: [
      'the Reserved check passed, an Evidence manifest is pinned, and the `effect` fits the Task as "Decision effects" requires',
    ],
    meta: (output) => ({ opKey: output.op_key, orca: output.orca }),
  }),
  row({
    name: "decide ruling",
    input: DecideRulingInput,
    output: DecideRulingOutput,
    handler: decideRulingVerb,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
    render: renderRuling,
  }),
  row({
    name: "decide cancel",
    input: DecideCancelInput,
    output: DecideCancelOutput,
    handler: decideCancelVerb,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "an open Decision and an owner generation that matches its Run",
    ],
    meta: (output) => ({ ownerGeneration: output.owner_generation }),
  }),
  row({
    name: "check",
    input: CheckInput,
    output: CheckOutput,
    handler: checkVerb,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "the delivery's `payload.dispatchId` matches a recorded Dispatch, or a Decision Seat's message for an open Decision, and its owner generation matches the Run",
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
  row({
    name: "verdict post",
    input: VerdictPostInput,
    output: VerdictPostOutput,
    handler: verdictPostVerb,
    sideEffect: "tracker",
    cancelBy: ["operator"],
    evidenceRequired: [
      "Head SHA equals the current candidate SHA, and the reviewer is not the developer",
    ],
    meta: gateMeta,
  }),
  row({
    name: "hqa record",
    input: HqaRecordInput,
    output: HqaRecordOutput,
    handler: hqaRecordVerb,
    sideEffect: "tracker",
    cancelBy: ["operator"],
    evidenceRequired: [
      "a source-verified comment by the human gatekeeper, or by the relay principal with a matching content hash, plus a deploy event for `hqa_after_deploy`",
    ],
    meta: gateMeta,
  }),
  row({
    name: "drain",
    input: DrainInput,
    output: DrainOutput,
    handler: drainVerb,
    sideEffect: "ledger",
    cancelBy: ["operator"],
    evidenceRequired: ["an owner generation that matches the Run"],
    meta: drainMeta,
  }),
  row({
    name: "takeover",
    input: TakeoverInput,
    output: TakeoverOutput,
    handler: takeoverVerb,
    sideEffect: "orca",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "evidence that the old coordinator has stopped, which on an xl Run is the decider Dispatch",
    ],
    meta: runMeta,
  }),
  row({
    name: "learning add",
    input: LearningAddInput,
    output: LearningAddOutput,
    handler: learningAdd,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a source Story, at least one evidence reference, and an `area`",
    ],
    meta: learningAddMeta,
  }),
  row({
    name: "learning query",
    input: LearningQueryInput,
    output: LearningQueryOutput,
    handler: learningQuery,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
  }),
];
