import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { checkPass, checkWait, resume } from "../core/check/check.ts";
import { launchLeaseSeconds } from "../core/check/reconcile.ts";
import { dispatch } from "../core/dispatch/dispatch.ts";
import { release } from "../core/dispatch/release.ts";
import {
  retry,
  retryPlan,
  supersededWorktree,
} from "../core/dispatch/retry.ts";
import { Size } from "../core/domain/ledger.ts";
import type { Refused } from "../core/domain/outcome.ts";
import { receiptLog, type ReceiptLog } from "../core/ledger/receipts.ts";
import type { Db } from "../core/ports/db.ts";
import type { DocsPort } from "../core/ports/docs.ts";
import type { TrackerPort } from "../core/ports/tracker.ts";
import {
  OrcaVersionUnsupported,
  orcaRangeText,
  ReleaseState,
  type OrcaPort,
} from "../core/ports/orca.ts";
import { runCreate } from "../core/run/create.ts";
import { docsFor } from "./docs.ts";
import { exitFor, PodError, throwRecordRefusal, usageError } from "./errors.ts";
import { gitStatus } from "./git.ts";
import {
  databaseUrl,
  podHome,
  readHostProfile,
  type HostSettings,
} from "./host-profile.ts";
import { orcaFor } from "./orca.ts";
import { trackerFor } from "./tracker.ts";

interface Wiring {
  db: Db;
  orca: OrcaPort;
  tracker: TrackerPort | null;
  docs: DocsPort | null;
  log: ReceiptLog;
  host: HostSettings;
}

export async function withOrca<R extends { ok: true }>(
  work: (wiring: Wiring) => Promise<R | Refused>,
): Promise<R> {
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const log = receiptLog(connection.db, host.hostId);
    const orca = orcaFor(log.sink, host.hostId);
    const tracker = await trackerFor(log.trackerSink, host);
    const docs = await docsFor(log.docsSink, host);
    const outcome = await work({
      db: connection.db,
      orca: orca.port,
      tracker: tracker?.port ?? null,
      docs: docs?.port ?? null,
      log,
      host,
    });
    throwRecordRefusal([
      ...orca.recordRefusals(),
      ...(tracker?.recordRefusals() ?? []),
      ...(docs?.recordRefusals() ?? []),
    ]);
    if (!outcome.ok) {
      const { code, message, nextSteps } = outcome.refusal;
      throw new PodError(code, exitFor(code), message, nextSteps);
    }
    return outcome;
  } catch (error) {
    if (error instanceof OrcaVersionUnsupported)
      throw new PodError("orca_version_unsupported", 3, error.message, [
        `supported Orca range ${orcaRangeText()}`,
        `installed Orca ${error.installed}`,
      ]);
    throw error;
  } finally {
    await connection.close();
  }
}

export function quote(value: string): string {
  return /^[\w@:./=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export const RunCreateInput = z.strictObject({
  args: z.tuple([z.string().regex(/^story:.+$/)]),
  process: z.string().optional(),
  size: Size.optional(),
  stage: z.string().min(1).optional(),
});
type RunCreateInput = z.infer<typeof RunCreateInput>;

export const RunCreateOutput = z.object({
  run_id: z.string(),
  story: z.string(),
  process: z.string(),
  snapshot_hash: z.string(),
  owner_generation: z.int(),
  tasks: z.array(
    z.object({
      task_id: z.string(),
      step_id: z.string(),
      role: z.string(),
      state: z.string(),
    }),
  ),
  op_key: z.string(),
  orca: z.string(),
});
type RunCreateOutput = z.infer<typeof RunCreateOutput>;

function processRef(
  value: string | undefined,
): { name: string; rev: number } | null {
  if (value === undefined) return null;
  const match = /^(.+)@([1-9][0-9]*)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined)
    throw usageError(`--process ${value} is not name@rev`);
  return { name: match[1], rev: Number(match[2]) };
}

export async function runCreateVerb(
  input: RunCreateInput,
): Promise<RunCreateOutput> {
  const coordinator = process.env["POD_COORDINATOR"];
  if (coordinator === undefined || coordinator === "")
    throw usageError("POD_COORDINATOR is not set", [
      "set POD_COORDINATOR to the coordinator session id",
    ]);
  const [story] = input.args;
  const ref = processRef(input.process);
  const command = [
    "pod",
    "run",
    "create",
    story,
    ...(input.process === undefined ? [] : ["--process", input.process]),
    ...(input.size === undefined ? [] : ["--size", input.size]),
    ...(input.stage === undefined ? [] : ["--stage", input.stage]),
  ]
    .map(quote)
    .join(" ");
  const { result, opKey, orca } = await withOrca(
    ({ db, orca: port, tracker, log, host }) =>
      runCreate(db, port, tracker, log, {
        story: story.slice("story:".length),
        process: ref,
        size: input.size ?? null,
        stage: input.stage ?? null,
        coordinator,
        host: host.hostId,
        provider: host.trackerKind,
        command,
        now: () => new Date(),
      }),
  );
  return { ...result, op_key: opKey, orca };
}

export function runMeta(output: {
  owner_generation: number;
  op_key: string;
  orca: string;
}) {
  return {
    ownerGeneration: output.owner_generation,
    opKey: output.op_key,
    orca: output.orca,
  };
}

export const DispatchInput = z.strictObject({
  args: z.tuple([]),
  task: z.string().min(1),
  seat: z.string().min(1),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  "op-key": z.string().min(1).optional(),
});
type DispatchInput = z.infer<typeof DispatchInput>;

export const DispatchOutput = z.object({
  dispatch_id: z.string(),
  task_id: z.string(),
  run_id: z.string(),
  seat: z.string(),
  manifest_id: z.string(),
  model_attribution: z.enum(["receipt", "unknown"]),
  terminal_handle: z.string().nullable(),
  owner_generation: z.int(),
  nextSteps: z.array(z.string()).optional(),
  op_key: z.string(),
  orca: z.string(),
});
type DispatchOutput = z.infer<typeof DispatchOutput>;

export async function dispatchVerb(
  input: DispatchInput,
): Promise<DispatchOutput> {
  const command = (opKey: string) =>
    [
      "pod",
      "dispatch",
      "--task",
      input.task,
      "--seat",
      input.seat,
      "--generation",
      input.generation,
      "--op-key",
      opKey,
    ]
      .map(quote)
      .join(" ");
  const { result, opKey, orca } = await withOrca(
    async ({ db, orca: port, log, host }) => {
      const worktree = await supersededWorktree(db, input.task, host.hostId);
      return dispatch(db, port, log, {
        task: input.task,
        seat: input.seat,
        generation: Number(input.generation),
        opKey: input["op-key"] ?? null,
        host: host.hostId,
        capacity: host.capacity,
        command,
        ...(worktree === null ? {} : { gitStatus: gitStatus(worktree) }),
        now: () => new Date(),
      });
    },
  );
  return { ...result, op_key: opKey, orca };
}

export const Generation = z.string().regex(/^[1-9][0-9]*$/);
const Seconds = z.string().regex(/^[1-9][0-9]*$/);

export const CheckInput = z
  .strictObject({
    args: z.tuple([]),
    run: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    generation: Generation,
    wait: z.boolean().optional(),
    interval: Seconds.optional(),
    timeout: Seconds.optional(),
    decision: z.string().min(1).optional(),
    resume: z.boolean().optional(),
  })
  .refine((input) =>
    input.resume === true
      ? (input.run === undefined) !== (input.task === undefined) &&
        input.wait === undefined &&
        input.interval === undefined &&
        input.timeout === undefined &&
        input.decision === undefined
      : input.run !== undefined &&
        input.task === undefined &&
        (input.wait === true ||
          (input.interval === undefined &&
            input.timeout === undefined &&
            input.decision === undefined)),
  );
type CheckInput = z.infer<typeof CheckInput>;

const PassOutput = z.object({
  run_id: z.string(),
  reconciled: z.array(
    z.object({
      op_key: z.string(),
      to: z.string(),
    }),
  ),
  deliveries: z.array(
    z.object({
      message_id: z.string(),
      dispatch_id: z.string(),
      outcome: z.string(),
    }),
  ),
  ignored: z.int(),
  acked: z.array(z.string()),
  stopped: z.array(z.string()),
  unknown_workers: z.array(z.string()),
  free_slots: z.int(),
  nextSteps: z.array(z.string()),
  owner_generation: z.int(),
  orca: z.string().nullable(),
});

const ResumeOutput = z.object({
  run_id: z.string(),
  resumed: z.array(
    z.object({ kind: z.enum(["run", "task"]), id: z.string(), to: z.string() }),
  ),
  owner_generation: z.int(),
  orca: z.string().nullable(),
});

export const CheckOutput = z.union([PassOutput, ResumeOutput]);
type CheckOutput = z.infer<typeof CheckOutput>;

function leaseSeconds(): number {
  const value = process.env["POD_LAUNCH_LEASE_SECONDS"];
  if (value === undefined || value === "") return launchLeaseSeconds;
  if (!Seconds.safeParse(value).success)
    throw usageError(
      `POD_LAUNCH_LEASE_SECONDS must be a positive whole number of seconds, got ${JSON.stringify(value)}`,
      [
        `unset POD_LAUNCH_LEASE_SECONDS for the ${launchLeaseSeconds}-second default`,
      ],
    );
  return Number(value);
}

export async function checkVerb(input: CheckInput): Promise<CheckOutput> {
  const lease = leaseSeconds();
  const generation = Number(input.generation);
  const now = () => new Date();
  if (input.resume === true) {
    const { result } = await withOrca(({ db, host }) =>
      resume(db, {
        run: input.run ?? null,
        task: input.task ?? null,
        generation,
        host: host.hostId,
        now,
      }),
    );
    return { ...result, owner_generation: generation, orca: null };
  }
  const run = input.run ?? "";
  const { result, orca } = await withOrca(
    ({ db, orca: port, tracker, log, host }) => {
      const pass = {
        run,
        generation,
        host: host.hostId,
        capacity: host.capacity,
        now,
        leaseSeconds: lease,
        hostName: hostname(),
        bypassPath: join(podHome(), "bypass.jsonl"),
      };
      return input.wait === true
        ? checkWait(db, port, tracker, log, {
            ...pass,
            decision: input.decision ?? null,
            interval: Number(input.interval ?? "10"),
            timeout: Number(input.timeout ?? "600"),
            sleep: (seconds) =>
              new Promise((done) => setTimeout(done, seconds * 1000)),
          })
        : checkPass(db, port, tracker, log, pass);
    },
  );
  return { ...result, owner_generation: generation, orca };
}

export function checkMeta(output: {
  owner_generation: number;
  orca: string | null;
}) {
  return {
    ownerGeneration: output.owner_generation,
    ...(output.orca === null ? {} : { orca: output.orca }),
  };
}

export const RetryInput = z.strictObject({
  args: z.tuple([]),
  dispatch: z.string().min(1),
  generation: Generation,
  "op-key": z.string().min(1).optional(),
});
type RetryInput = z.infer<typeof RetryInput>;

export const RetryOutput = DispatchOutput.extend({
  retry_of: z.string(),
  task_view: z.string(),
});
type RetryOutput = z.infer<typeof RetryOutput>;

export async function retryVerb(input: RetryInput): Promise<RetryOutput> {
  const command = (opKey: string) =>
    [
      "pod",
      "retry",
      "--dispatch",
      input.dispatch,
      "--generation",
      input.generation,
      "--op-key",
      opKey,
    ]
      .map(quote)
      .join(" ");
  const { result, opKey, orca } = await withOrca(
    async ({ db, orca: port, log, host }) => {
      const plan = await retryPlan(db, input.dispatch, host.hostId);
      if ("ok" in plan) return plan;
      return retry(db, port, log, {
        dispatch: input.dispatch,
        generation: Number(input.generation),
        opKey: input["op-key"] ?? null,
        host: host.hostId,
        capacity: host.capacity,
        gitStatus: gitStatus(plan.worktreePath),
        command,
        now: () => new Date(),
      });
    },
  );
  return { ...result, op_key: opKey, orca };
}

export const ReleaseInput = z
  .strictObject({
    args: z.tuple([]),
    dispatch: z.string().min(1),
    generation: Generation,
    retain: z.boolean().optional(),
    reason: z.string().min(1).optional(),
  })
  .refine((input) => (input.retain === true) === (input.reason !== undefined));
type ReleaseInput = z.infer<typeof ReleaseInput>;

export const ReleaseOutput = z.object({
  dispatch_id: z.string(),
  state: ReleaseState,
  reason: z.string().nullable(),
  owner_generation: z.int(),
  op_key: z.string(),
  orca: z.string(),
});
type ReleaseOutput = z.infer<typeof ReleaseOutput>;

export async function releaseVerb(input: ReleaseInput): Promise<ReleaseOutput> {
  const { result, opKey, orca } = await withOrca(
    ({ db, orca: port, log, host }) =>
      release(db, port, log, {
        dispatch: input.dispatch,
        generation: Number(input.generation),
        retain: input.reason ?? null,
        host: host.hostId,
        now: () => new Date(),
      }),
  );
  return { ...result, op_key: opKey, orca };
}
