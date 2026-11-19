import { ZodObject, type ZodType } from "zod";
import {
  ConfigApplyInput,
  ConfigApplyOutput,
  ConfigExportInput,
  ConfigExportOutput,
  ConfigGetInput,
  ConfigGetOutput,
  ConfigListInput,
  ConfigListOutput,
  ConfigActivateInput,
  configActivate,
  configApply,
  configExport,
  configGet,
  configList,
  configSet,
  ConfigSetInput,
} from "./config-verbs.ts";
import { BriefInput, BriefOutput, brief } from "./brief.ts";
import { type PodError, usageError } from "./errors.ts";
import { LogInput, LogOutput, logVerb, renderLog } from "./log-verbs.ts";
import {
  PlanHoldInput,
  PlanInput,
  PlanListInput,
  PlanOutput,
  PlanOverrideOutput,
  PlanReleaseInput,
  plan,
  planHold,
  planOpKeyMeta,
  planOrder,
  planPriority,
  planRelease,
  planResetAvailable,
  planResetUsed,
  planStretch,
  PlanResetAvailableInput,
  PlanResetUsedInput,
  PlanStretchInput,
} from "./plan-verbs.ts";
import { TickInput, TickOutput, tick, tickOpKeyMeta } from "./tick-verbs.ts";
import {
  standup,
  standupDone,
  StandupDoneInput,
  StandupInput,
  standupMeta,
  StandupOutput,
  standupSkip,
  StandupSkipInput,
} from "./standup-verbs.ts";
import { StandupResult } from "../core/standup/record.ts";
import {
  digestAssign,
  DigestAssignInput,
  DigestAssignOutput,
  digestDecide,
  DigestDecideInput,
  DigestDecideOutput,
  digestPost,
  DigestPostInput,
  DigestPostOutput,
  digestPrepare,
  DigestPrepareInput,
  DigestPrepareOutput,
  DigestQueueInput,
  DigestQueueOutput,
  digestQueueVerb,
  opKeyMeta,
} from "./digest-verbs.ts";
import {
  LearningAddInput,
  LearningAddOutput,
  LearningQueryInput,
  LearningQueryOutput,
  learningAdd,
  learningAddMeta,
  learningImport,
  LearningImportInput,
  LearningImportOutput,
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
import {
  DeployRecordInput,
  DeployRecordOutput,
  deployMeta,
  deployRecordVerb,
} from "./deploy-verbs.ts";
import { DbMigrateInput, DbMigrateOutput, dbMigrate } from "./db-verbs.ts";
import {
  RetroRecordInput,
  RetroRecordOutput,
  retroMeta,
  retroRecordVerb,
  RetroRunInput,
  RetroRunOutput,
  retroRunVerb,
} from "./retro-verbs.ts";
import {
  DocsReadInput,
  DocsReadOutput,
  docsRead,
  renderSection,
} from "./docs-verbs.ts";
import { StateInput, StateOutput, stateVerb } from "./state-verbs.ts";
import {
  renderUsage,
  UsageInput,
  UsageOutput,
  UsageRecordInput,
  UsageRecordOutput,
  usageRecordVerb,
  usageVerb,
} from "./usage-verbs.ts";
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
  ReplyInput,
  ReplyOutput,
  replyVerb,
  RetryInput,
  RetryOutput,
  retryVerb,
  runCloseMeta,
  RunCloseInput,
  RunCloseOutput,
  runCloseVerb,
  RunCreateInput,
  RunCreateOutput,
  runCreateVerb,
  RunLaunchInput,
  runLaunchMeta,
  RunLaunchOutput,
  runLaunchVerb,
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

export function usageFor(verb: VerbRow<unknown, unknown>): PodError {
  const keys =
    verb.input instanceof ZodObject ? Object.keys(verb.input.shape) : [];
  const flags = keys.filter((key) => key !== "args").map((key) => `[--${key}]`);
  return usageError(`usage: ${verb.name}`, [
    ["pod", verb.name, ...flags].join(" "),
    "pod --help",
  ]);
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
    name: "config set",
    input: ConfigSetInput,
    output: ConfigApplyOutput,
    handler: configSet,
    sideEffect: "config",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "an existing source Revision, an edit that passes its kind's schema, and the active Revision unchanged since it was read when `--activate` is set",
    ],
  }),
  row({
    name: "config activate",
    input: ConfigActivateInput,
    output: ConfigApplyOutput,
    handler: configActivate,
    sideEffect: "config",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "an existing Revision at the named scope, run by a person, and `expected_revision` equal to the active Revision",
    ],
  }),
  row({
    name: "config export",
    input: ConfigExportInput,
    output: ConfigExportOutput,
    handler: configExport,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: ["a Revision named by kind.name@rev, or --all"],
  }),
  row({
    name: "config get",
    input: ConfigGetInput,
    output: ConfigGetOutput,
    handler: configGet,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: ["an active Revision of kind.name at the scope"],
  }),
  row({
    name: "config list",
    input: ConfigListInput,
    output: ConfigListOutput,
    handler: configList,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: ["a config kind"],
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
    name: "run close",
    input: RunCloseInput,
    output: RunCloseOutput,
    handler: runCloseVerb,
    sideEffect: "tracker",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "every Task done, superseded, or failed; no running Dispatch other than the Run's coordinator Dispatch; no open or needs_human Decision; no text in the composer of an open Dispatch terminal other than the coordinator's, read from a rendered screen; and no untracked file and no branch ahead of its upstream in the Run's worktrees, unless `--keep-files-reviewed` is passed",
    ],
    meta: runCloseMeta,
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
    name: "run launch",
    input: RunLaunchInput,
    output: RunLaunchOutput,
    handler: runLaunchVerb,
    sideEffect: "orca",
    cancelBy: ["operator"],
    evidenceRequired: [
      "a Story in the host's published plan for today, a crew Seat for the lead role of the first step, no attention pause, usage headroom for the lead Seat's runtime, and a free slot after other projects' unused reserved slots",
    ],
    meta: runLaunchMeta,
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
      "the delivery's `payload.dispatchId` matches a recorded Dispatch, or a Decision Seat's message for an open Decision, and its owner generation matches the Run; `--observe` reads no delivery; with `--run` it needs a Run of this host, and without `--run` it reads this host's open Dispatches with no Run",
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
    name: "reply",
    input: ReplyInput,
    output: ReplyOutput,
    handler: replyVerb,
    sideEffect: "orca",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a waiting delivery on an open Run Dispatch that is not a decider or auditor, recorded by pod check, and an owner generation that matches its Run",
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
      "a source-verified comment by the human gatekeeper, or by the relay principal with a matching content hash, plus a deploy event for `hqa_after_deploy`, run from the operator's shell by the gate's keeper",
    ],
    meta: gateMeta,
  }),
  row({
    name: "deploy record",
    input: DeployRecordInput,
    output: DeployRecordOutput,
    handler: deployRecordVerb,
    sideEffect: "ledger",
    cancelBy: ["operator"],
    evidenceRequired: [
      "a deploy line whose deployed_revision matches the Run's candidate SHA or its tree",
    ],
    meta: deployMeta,
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
    name: "learning import",
    input: LearningImportInput,
    output: LearningImportOutput,
    handler: learningImport,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a FILE of rows, each with a `source_ref` and at least one occurrence",
    ],
  }),
  row({
    name: "retro",
    input: RetroRunInput,
    output: RetroRunOutput,
    handler: retroRunVerb,
    sideEffect: "orca",
    cancelBy: ["coordinator", "operator"],
    evidenceRequired: [
      "a `close` event with `retro_due` true, a pinned process with a `retro` step that runs after close, the Run's owner host, and a Seat with no Dispatch in the Run",
    ],
    meta: retroMeta,
  }),
  row({
    name: "retro record",
    input: RetroRecordInput,
    output: RetroRecordOutput,
    handler: retroRecordVerb,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a Run due a retro, a FILE of findings each with at least one evidence reference, and the `tech` kind in the policy's `learning.kinds`",
    ],
    meta: retroMeta,
  }),
  row({
    name: "usage",
    input: UsageInput,
    output: UsageOutput,
    handler: usageVerb,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
    render: renderUsage,
  }),
  row({
    name: "log",
    input: LogInput,
    output: LogOutput,
    handler: logVerb,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
    render: renderLog,
  }),
  row({
    name: "usage record",
    input: UsageRecordInput,
    output: UsageRecordOutput,
    handler: usageRecordVerb,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a FILE or stdin of normalized usage rows, each line one unit or window object",
    ],
  }),
  row({
    name: "plan",
    input: PlanInput,
    output: PlanOutput,
    handler: plan,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "an active host Revision with a timezone for the host; `--publish` writes the plan",
    ],
  }),
  row({
    name: "standup",
    input: StandupInput,
    output: StandupOutput,
    handler: standup,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: ["an active host Revision with a timezone for the host"],
  }),
  row({
    name: "standup done",
    input: StandupDoneInput,
    output: StandupResult,
    handler: standupDone,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a `person:` actor and an active host Revision with a timezone for the host",
    ],
    meta: standupMeta,
  }),
  row({
    name: "standup skip",
    input: StandupSkipInput,
    output: StandupResult,
    handler: standupSkip,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a `person:` actor, a `--reason`, and an active host Revision with a timezone for the host",
    ],
    meta: standupMeta,
  }),
  row({
    name: "plan hold",
    input: PlanHoldInput,
    output: PlanOverrideOutput,
    handler: planHold,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a KEY, a `--reason`, an `--until` no earlier than the host's day, and an active host Revision with a timezone",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan release",
    input: PlanReleaseInput,
    output: PlanOverrideOutput,
    handler: planRelease,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: ["a hold on KEY in force on the host"],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan priority",
    input: PlanListInput,
    output: PlanOverrideOutput,
    handler: planPriority,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "one or more distinct PROJECTs, an `--until` no earlier than the host's day, and an active host Revision with a timezone",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan order",
    input: PlanListInput,
    output: PlanOverrideOutput,
    handler: planOrder,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "one or more distinct KEYs, an `--until` no earlier than the host's day, and an active host Revision with a timezone",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan stretch",
    input: PlanStretchInput,
    output: PlanOverrideOutput,
    handler: planStretch,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "SLOTS above slots.default and at most slots.max of the active host Revision, a `--reason`, and a person as the actor; it expires at the end of the host's day",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan reset-available",
    input: PlanResetAvailableInput,
    output: PlanOverrideOutput,
    handler: planResetAvailable,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a HARNESS, an `--until` no earlier than the host's day, and an active host Revision with a timezone",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "plan reset-used",
    input: PlanResetUsedInput,
    output: PlanOverrideOutput,
    handler: planResetUsed,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a reset-available mark on HARNESS in force on the host",
    ],
    meta: planOpKeyMeta,
  }),
  row({
    name: "tick",
    input: TickInput,
    output: TickOutput,
    handler: tick,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "an active schedule Revision for the host; each `--trigger` is SOURCE:ID with SOURCE orchestration, tracker, timer, or operator; `--agenda meta` runs the host's due `meta_slots` and takes `--slot NAME` and no `--trigger`; `--dry-run` writes nothing",
    ],
    meta: tickOpKeyMeta,
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
  row({
    name: "digest prepare",
    input: DigestPrepareInput,
    output: DigestPrepareOutput,
    handler: digestPrepare,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
  }),
  row({
    name: "digest post",
    input: DigestPostInput,
    output: DigestPostOutput,
    handler: digestPost,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: [
      "a FILE of proposals, each with a `theme`, `text`, and at least one learning id",
    ],
    meta: opKeyMeta,
  }),
  row({
    name: "digest decide",
    input: DigestDecideInput,
    output: DigestDecideOutput,
    handler: digestDecide,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: ["a shown proposal number, a verdict, and a `--reason`"],
    meta: opKeyMeta,
  }),
  row({
    name: "digest queue",
    input: DigestQueueInput,
    output: DigestQueueOutput,
    handler: digestQueueVerb,
    sideEffect: "none",
    cancelBy: ["nobody"],
    evidenceRequired: [],
  }),
  row({
    name: "digest assign",
    input: DigestAssignInput,
    output: DigestAssignOutput,
    handler: digestAssign,
    sideEffect: "ledger",
    cancelBy: ["nobody"],
    evidenceRequired: ["an adopted learning id and a `story:<id>`"],
  }),
];
