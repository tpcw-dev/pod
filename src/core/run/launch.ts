import { z } from "zod";
import { launchSlotRefusal } from "../dispatch/launch-gate.ts";
import { dispatch } from "../dispatch/dispatch.ts";
import { openLaunches } from "../dispatch/quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "../dispatch/seats.ts";
import { Json } from "../domain/json.ts";
import type { Operation } from "../domain/ledger.ts";
import {
  refuse,
  RefusalCode,
  type Outcome,
  type Refusal,
} from "../domain/outcome.ts";
import { launchOutcome } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { hostCapacity } from "../plan/capacity.ts";
import { planHost, seatedProjects, type PlanHost } from "../plan/host.ts";
import { newestPublished, resetsInForce } from "../plan/overrides.ts";
import { usageGates } from "../plan/usage.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt, WorktreeResult } from "../ports/orca.ts";
import type { TrackerPort } from "../ports/tracker.ts";
import { attentionPaused } from "./attention-pause.ts";
import { runCreate, selectRun, type RunCreateInput } from "./create.ts";
import { readSteps } from "./steps.ts";

export interface LaunchPorts {
  orca: OrcaPort;
  tracker: TrackerPort | null;
  log: ReceiptLog;
}

export interface LaunchInput {
  story: string;
  host: string;
  provider: string;
  seats: Readonly<Record<string, string>>;
  subject: string;
  coordinator: string;
  command: string;
  now: () => Date;
}

export const LaunchResult = z.object({
  story: z.string(),
  run_id: z.string(),
  op_key: z.string(),
  replayed: z.boolean(),
  worktree: z.object({ id: z.string(), path: z.string(), branch: z.string() }),
  dispatch: z.object({
    dispatch_id: z.string(),
    task_id: z.string(),
    seat: z.string(),
  }),
});
export type LaunchResult = z.infer<typeof LaunchResult>;

type Worktree = LaunchResult["worktree"];

const Request = z.object({
  launch: z.literal(true),
  host: z.string(),
  project: z.string(),
  story: z.string(),
  subject: z.string(),
});
type Request = z.infer<typeof Request>;

const DispatchRefusal = z.object({
  code: RefusalCode,
  message: z.string(),
  nextSteps: z.array(z.string()),
  op_key: z.string(),
});

const Recorded = z.object({
  request: Request,
  worktree: LaunchResult.shape.worktree.optional(),
  run_id: z.string().optional(),
  task_id: z.string().optional(),
  seat: z.string().optional(),
  dispatch_id: z.string().optional(),
  dispatch: DispatchRefusal.optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});
type Recorded = z.infer<typeof Recorded>;

/** The runCreate refusals its own Story-keyed op returns to every caller, forever. */
const storedForever = new Set(["failed", "duplicate_op"]);

export function launchOpKey(
  host: string,
  subject: string,
  story: string,
): string {
  return derivedOpKey("tick", { host, step: "launch", subject, story });
}

export function worktreeName(story: string): string {
  return story.toLowerCase();
}

interface Lead {
  plan: PlanHost;
  project: string;
  repo: string;
  staging: boolean;
  create: RunCreateInput;
  stepId: string;
  seat: Seat;
}

function ofRefusal(refusal: Refusal): { ok: false; refusal: Refusal } {
  return { ok: false, refusal };
}

function planProject(plan: PlanHost, story: string): string | null {
  const published = newestPublished(plan.events, plan.day);
  const entry = [...(published?.ranked ?? []), ...(published?.held ?? [])].find(
    (row) => row.key === story,
  );
  return entry?.project ?? null;
}

function leadSeat(
  seats: readonly Seat[],
  role: string,
  host: string,
  model: string | undefined,
): Seat | undefined {
  return seats.find(
    (seat) =>
      seat.roles.includes(role) &&
      (seat.host === undefined || seat.host === host) &&
      (model === undefined || seat.model === model),
  );
}

async function readLead(
  db: Db,
  ports: LaunchPorts,
  input: LaunchInput,
): Promise<{ ok: true; lead: Lead } | { ok: false; refusal: Refusal }> {
  const plan = await planHost(db, input.host, input.now());
  if (!plan.ok) return plan;
  const project = planProject(plan, input.story);
  if (project === null)
    return refuse(
      "selector_none",
      `story:${input.story} is in no published plan for host ${input.host} today`,
      ["pod plan"],
    );
  const seated = (await seatedProjects(db, plan)).find(
    (row) => row.name === project,
  );
  if (seated?.value == null)
    return refuse(
      "selector_none",
      `project ${project} has no active project Revision seated on host ${input.host}`,
      [`pod config get project.${project}`],
    );
  const create: RunCreateInput = {
    story: input.story,
    process: null,
    size: null,
    stage: null,
    coordinator: input.coordinator,
    host: input.host,
    provider: input.provider,
    command: input.command,
    project,
    now: input.now,
  };
  const chosen = await selectRun(db, ports.tracker, ports.log, create);
  if (!chosen.ok) return chosen;
  const { process, crew } = chosen.selected;
  const first = readSteps(process.value).find(
    (step) => step.needs.length === 0,
  );
  if (first === undefined)
    throw new Error(`process.${process.name}@${process.rev} has no first step`);
  const role = first.role ?? first.type;
  const named = Object.keys(input.seats).filter((each) => each !== role);
  if (named.length > 0)
    return refuse(
      "usage",
      `--seat names role ${named.join(", ")}, but the lead role is ${role}`,
      [`--seat ${role}=MODEL`],
    );
  let seats: Seat[];
  try {
    seats = readSeats(crew.value);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    return refuse("schema_invalid", error.message, [error.path]);
  }
  const seat = leadSeat(seats, role, input.host, input.seats[role]);
  if (seat === undefined)
    return refuse(
      "role_unfilled",
      `no Seat fills the lead role ${role} of step ${first.id} on host ${input.host}`,
      [`role ${role}`, "pod config apply crew.yaml with a Seat that fills it"],
    );
  return {
    ok: true,
    lead: {
      plan,
      project,
      repo: seated.value.repo,
      staging: seated.value.staging,
      create,
      stepId: first.id,
      seat,
    },
  };
}

async function gate(
  tx: Repo,
  input: LaunchInput,
  lead: Lead,
  opKey: string,
): Promise<Refusal | null> {
  const { plan } = lead;
  const now = input.now();
  await tx.lockQuota(input.host);
  await tx.lockClaim(`${input.provider}:${input.story}`);
  const paused = await attentionPaused(tx, input.host, plan.timezone, now);
  if (paused !== null) return paused;
  const story = await tx.getStory(input.provider, input.story);
  if (story?.run_id != null)
    return {
      code: "duplicate_op",
      message: `Story ${input.story} has Run ${story.run_id}`,
      nextSteps: [`pod brief story:${input.story}`],
    };
  const inFlight = (await openLaunches(tx)).find(
    (row) =>
      row.intent === "tick" &&
      row.request?.story === input.story &&
      row.op_key !== opKey,
  );
  if (inFlight !== undefined)
    return {
      code: "duplicate_op",
      message: `Story ${input.story} has launch ${inFlight.op_key} in flight`,
      nextSteps: ["pod check"],
    };
  const held = (
    await usageGates(
      tx,
      [lead.seat.runtime],
      resetsInForce(plan.events, now),
      now,
    )
  ).filter((row) => row.state === "held");
  if (held.length > 0)
    return {
      code: "usage_hold",
      message: `usage holds ${held.map((row) => row.provider).join(", ")} for the lead Seat ${lead.seat.id}`,
      nextSteps: held.map(
        (row) =>
          `provider ${row.provider} reads ${row.value ?? "no value"}, pace ${row.pace ?? "unknown"}`,
      ),
    };
  return launchSlotRefusal(
    tx,
    input.host,
    lead.project,
    await hostCapacity(tx, input.host, now),
    plan.reserved,
  );
}

async function claim(
  db: Db,
  input: LaunchInput,
  lead: Lead,
  opKey: string,
): Promise<{ refusal: Refusal } | { recorded: Recorded }> {
  return db.transaction(async (tx) => {
    const refusal = await gate(tx, input, lead, opKey);
    if (refusal !== null) return { refusal };
    const request: Request = {
      launch: true,
      host: input.host,
      project: lead.project,
      story: input.story,
      subject: input.subject,
    };
    await tx.insertOperation({
      op_key: opKey,
      intent: "tick",
      owner_generation: 0,
      at: input.now(),
      result_ref: { request },
    });
    return { recorded: { request } };
  });
}

function receiptCode(receipt: Receipt<unknown>): string | null {
  return (
    z
      .looseObject({ error: z.looseObject({ code: z.string() }) })
      .safeParse(receipt.raw).data?.error.code ?? null
  );
}

function worktreeOf(receipt: Receipt<WorktreeResult>): Worktree | null {
  const found = receipt.exitCode === 0 ? receipt.result?.worktree : undefined;
  return found === undefined
    ? null
    : { id: found.id, path: found.path, branch: found.branch };
}

async function openWorktree(
  ports: LaunchPorts,
  input: LaunchInput,
  lead: Lead,
): Promise<{ ok: true; worktree: Worktree } | { ok: false; refusal: Refusal }> {
  const name = worktreeName(input.story);
  const shown = await ports.orca.worktreeShow({ worktree: `name:${name}` });
  const adopted = worktreeOf(shown);
  if (adopted !== null) return { ok: true, worktree: adopted };
  const receipt =
    receiptCode(shown) === "selector_not_found"
      ? await ports.orca.worktreeCreate({
          project: `github:${lead.repo}`,
          name,
          baseBranch: lead.staging ? "staging" : null,
          noParent: true,
        })
      : shown;
  const created = worktreeOf(receipt);
  if (created !== null) return { ok: true, worktree: created };
  const verb = receipt === shown ? "worktree-show" : "worktree-create";
  if (launchOutcome(receipt).kind === "unknown")
    return refuse(
      "launch_unknown",
      `${verb} for story:${input.story} has no known outcome`,
      [input.command],
    );
  return refuse(
    "failed",
    `${verb} for story:${input.story} failed: ${receiptCode(receipt) ?? `exit ${receipt.exitCode}`}`,
    [input.command],
  );
}

async function record(
  db: Db,
  opKey: string,
  status: "pending" | "done" | "refused",
  recorded: Recorded,
  at: Date,
): Promise<void> {
  await db.moveOperation(opKey, status, Json.parse(recorded), at);
}

function success(
  input: LaunchInput,
  opKey: string,
  replayed: boolean,
  recorded: { worktree: Worktree; run_id: string },
  dispatched: LaunchResult["dispatch"],
  orca: string,
): Outcome<LaunchResult> {
  return {
    ok: true,
    opKey,
    orca,
    result: {
      story: `story:${input.story}`,
      run_id: recorded.run_id,
      op_key: opKey,
      replayed,
      worktree: recorded.worktree,
      dispatch: dispatched,
    },
  };
}

async function replayDone(
  db: Db,
  input: LaunchInput,
  opKey: string,
  recorded: Recorded,
  orca: string,
): Promise<Outcome<LaunchResult>> {
  const { worktree, run_id: runId, task_id: taskId, seat } = recorded;
  if (
    worktree === undefined ||
    runId === undefined ||
    taskId === undefined ||
    seat === undefined
  )
    return refuse("failed", `launch ${opKey} has no recorded result`, [
      "pod check",
    ]);
  const runRef = { worktree, run_id: runId };
  if (recorded.dispatch_id !== undefined)
    return success(
      input,
      opKey,
      true,
      runRef,
      { dispatch_id: recorded.dispatch_id, task_id: taskId, seat },
      orca,
    );
  const [newest] = (await db.listDispatches(runId))
    .filter((row) => row.task_id === taskId)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  if (newest !== undefined)
    return success(
      input,
      opKey,
      true,
      runRef,
      { dispatch_id: newest.dispatch_id, task_id: taskId, seat: newest.seat },
      orca,
    );
  const stored = recorded.dispatch;
  return refuse(
    stored?.code ?? "failed",
    stored?.message ?? `launch ${opKey} dispatched no lead Seat`,
    stored?.nextSteps ?? ["pod check"],
  );
}

function dispatchRecovery(
  taskId: string,
  seat: string,
  generation: number,
): string {
  return `pod dispatch --task ${taskId} --seat ${seat} --generation ${generation} --op-key <new>`;
}

export async function runLaunch(
  db: Db,
  ports: LaunchPorts,
  input: LaunchInput,
): Promise<Outcome<LaunchResult>> {
  const opKey = launchOpKey(input.host, input.subject, input.story);
  const existing = await db.getOperation(opKey);
  const prior = existing === null ? null : priorOf(existing, opKey);
  if (prior !== null && "refusal" in prior) return prior;
  if (prior?.status === "done")
    return replayDone(
      db,
      input,
      opKey,
      prior.recorded,
      (await ports.orca.version()).version,
    );
  if (prior?.status === "refused")
    return refuse(
      prior.recorded.code ?? "failed",
      prior.recorded.message ?? `launch ${opKey} was refused`,
      prior.recorded.nextSteps ?? [],
    );

  const read = await readLead(db, ports, input);
  if (!read.ok) return read;
  const { lead } = read;
  let recorded: Recorded;
  if (prior === null) {
    const claimed = await claim(db, input, lead, opKey);
    if ("refusal" in claimed) return ofRefusal(claimed.refusal);
    recorded = claimed.recorded;
  } else recorded = prior.recorded;
  const { version } = await ports.orca.version();

  if (recorded.worktree === undefined) {
    const opened = await openWorktree(ports, input, lead);
    if (!opened.ok) return opened;
    recorded = { ...recorded, worktree: opened.worktree };
    await record(db, opKey, "pending", recorded, input.now());
  }
  const worktree = recorded.worktree;
  if (worktree === undefined)
    throw new Error(`launch ${opKey} lost its worktree`);

  if (recorded.run_id === undefined) {
    const created = await runCreate(
      db,
      ports.orca,
      ports.tracker,
      ports.log,
      lead.create,
    );
    if (!created.ok) {
      if (storedForever.has(created.refusal.code))
        await record(
          db,
          opKey,
          "refused",
          { ...recorded, ...created.refusal },
          input.now(),
        );
      return created;
    }
    recorded = { ...recorded, run_id: created.result.run_id };
    await record(db, opKey, "pending", recorded, input.now());
  }
  const runId = recorded.run_id;
  if (runId === undefined) throw new Error(`launch ${opKey} lost its Run`);

  const run = await db.getRun(runId);
  const task = (await db.listTasks(runId)).find(
    (row) => row.step_id === lead.stepId,
  );
  if (run === null || task === undefined)
    throw new Error(`Run ${runId} has no Task for step ${lead.stepId}`);
  const dispatched = await dispatch(db, ports.orca, ports.log, {
    task: task.task_id,
    seat: lead.seat.id,
    generation: run.owner_generation,
    opKey: null,
    host: input.host,
    capacity: await hostCapacity(db, input.host, input.now()),
    command: () => input.command,
    worktree: `id:${worktree.id}`,
    heldBy: opKey,
    now: input.now,
  });
  const base = { ...recorded, task_id: task.task_id, seat: lead.seat.id };
  if (dispatched.ok) {
    await record(
      db,
      opKey,
      "done",
      { ...base, dispatch_id: dispatched.result.dispatch_id },
      input.now(),
    );
    return success(
      input,
      opKey,
      false,
      { worktree, run_id: runId },
      {
        dispatch_id: dispatched.result.dispatch_id,
        task_id: task.task_id,
        seat: lead.seat.id,
      },
      version,
    );
  }
  const refusal: Refusal = {
    ...dispatched.refusal,
    nextSteps: [
      ...dispatched.refusal.nextSteps,
      dispatchRecovery(task.task_id, lead.seat.id, run.owner_generation),
    ],
  };
  await record(
    db,
    opKey,
    "done",
    {
      ...base,
      dispatch: {
        ...refusal,
        op_key: derivedOpKey("dispatch", {
          run_id: runId,
          task_id: task.task_id,
          seat: lead.seat.id,
          attempt: "1",
        }),
      },
    },
    input.now(),
  );
  return ofRefusal(refusal);
}

function priorOf(
  existing: Operation,
  opKey: string,
):
  | { status: Operation["status"]; recorded: Recorded }
  | { ok: false; refusal: Refusal } {
  const recorded = Recorded.safeParse(existing.result_ref);
  if (existing.intent !== "tick" || !recorded.success)
    return refuse(
      "duplicate_op",
      `op key ${opKey} belongs to another intent or request`,
      ["pod check"],
    );
  return { status: existing.status, recorded: recorded.data };
}
