import { z } from "zod";
import { operationStatuses, type Run, type Task } from "../domain/ledger.ts";
import { nextDispatchCommand } from "../dispatch/next-command.ts";
import { openLaunches } from "../dispatch/quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "../dispatch/seats.ts";
import { candidateSha, gateOf, pinnedConfig } from "../gate/receipt.ts";
import { latestDispatch } from "../domain/hold.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import type { Db } from "../ports/db.ts";
import { readProcess } from "../process/project.ts";
import { afterClose, type Step } from "../process/schema.ts";
import {
  openQuestions,
  questionLine,
  questionsOn,
  type Question,
} from "./reply.ts";

export interface NextSteps {
  lines: string[];
  runnableCount: number;
}

interface Open {
  task: Task;
  step: Step;
}

interface Context {
  run: Run;
  generation: number;
  host: string;
}

const nextKeyCodes = ["quota_exhausted", "drained"] as const;

const Request = z.looseObject({ task_id: z.string(), seat: z.string() });

const Retryable = z.union([
  z.looseObject({ request: Request, code: z.enum(nextKeyCodes) }),
  z.looseObject({ request: Request, outcome: z.literal("failed") }),
]);

const DispatchRequest = z.looseObject({
  request: z.looseObject({ task_id: z.string() }),
});

export async function nextSteps(
  db: Db,
  input: Context & { freeSlots: number },
): Promise<NextSteps & { questions: Question[] }> {
  const run = (await db.getRun(input.run.run_id)) ?? input.run;
  const context = { ...input, run };
  const tasks = await db.listTasks(run.run_id);
  const open: Open[] = [];
  for (const task of tasks)
    if (task.state === "ready" || task.state === "delivered")
      open.push({ task, step: (await readProcess(db, task, task.state)).step });
  const pinned = await pinnedConfig(db, run.run_id);
  const lines: string[] = [];
  let runnableCount = 0;
  if (input.freeSlots >= 1 && !(await drainInForce(db, run.run_id))) {
    const keys = await nextKeys(db, context, tasks);
    const ready = await readyLines(db, context, open, keys.tasks, pinned?.crew);
    const retries = await retryLines(db, context, tasks);
    lines.push(...keys.lines, ...ready.lines, ...retries);
    runnableCount += keys.lines.length + ready.runnableCount + retries.length;
  }
  const gated = await gateLines(db, context, open, pinned?.policy);
  lines.push(...gated.lines);
  const questions = await openQuestions(db, run);
  lines.push(
    ...questions.map((question) => questionLine(question, input.generation)),
  );
  return {
    lines,
    runnableCount: runnableCount + gated.runnableCount + questions.length,
    questions,
  };
}

async function nextKeys(
  db: Db,
  { run, generation }: Context,
  tasks: readonly Task[],
): Promise<{ lines: string[]; tasks: Set<string> }> {
  const ready = new Set(
    tasks.filter((task) => task.state === "ready").map((task) => task.task_id),
  );
  const seen = new Set<string>();
  const named = new Set<string>();
  const lines: string[] = [];
  for (const operation of await db.listOperations(
    ["dispatch"],
    ["refused", "done"],
  )) {
    const ref = Retryable.safeParse(operation.result_ref);
    if (!ref.success) continue;
    const { task_id, seat } = ref.data.request;
    const pair = `${task_id}\n${seat}`;
    if (!ready.has(task_id) || seen.has(pair)) continue;
    seen.add(pair);
    named.add(task_id);
    lines.push(
      await nextDispatchCommand(db, {
        run_id: run.run_id,
        task_id,
        seat,
        generation,
      }),
    );
  }
  return { lines, tasks: named };
}

async function readyLines(
  db: Db,
  { run, generation, host }: Context,
  open: readonly Open[],
  named: ReadonlySet<string>,
  crew: unknown,
): Promise<NextSteps> {
  const tried = new Set<string | undefined>();
  for (const operation of await db.listOperations(
    ["dispatch"],
    operationStatuses,
  ))
    tried.add(
      DispatchRequest.safeParse(operation.result_ref).data?.request.task_id,
    );
  for (const launch of await openLaunches(db))
    tried.add(launch.request?.task_id);
  const dispatches = await db.listDispatches(run.run_id);
  let crewSeats: Seat[] | SeatsInvalid;
  try {
    crewSeats = readSeats(crew);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    crewSeats = error;
  }
  const lines: string[] = [];
  let runnableCount = 0;
  for (const { task, step } of open) {
    if (task.state !== "ready" || step.type !== "worker") continue;
    if (named.has(task.task_id) || tried.has(task.task_id)) continue;
    if (afterClose(step) || run.state !== "active") continue;
    const waits = `Task ${task.task_id} waits for a Seat for role ${task.role} on host ${host}`;
    if (crewSeats instanceof SeatsInvalid) {
      lines.push(`${waits}; ${crewSeats.message}`);
      continue;
    }
    const seats = crewSeats
      .filter(
        (seat) =>
          seat.roles.includes(task.role) &&
          (seat.host === undefined || seat.host === host) &&
          !(
            task.role === "reviewer" &&
            dispatches.some(
              (row) => row.seat === seat.id && row.role === "developer",
            )
          ),
      )
      .map((seat) => seat.id);
    const command = `pod dispatch --task ${task.task_id} --seat`;
    const [only] = seats;
    if (only === undefined) {
      lines.push(
        `${waits}; pod config apply crew.yaml with a Seat that fills it`,
      );
      continue;
    }
    lines.push(
      seats.length === 1
        ? `${command} ${only} --generation ${generation}`
        : `${command} SEAT --generation ${generation}, with a Seat for role ${task.role} from pod brief (${seats.join(", ")})`,
    );
    runnableCount += 1;
  }
  return { lines, runnableCount };
}

async function retryLines(
  db: Db,
  { run, generation }: Context,
  tasks: readonly Task[],
): Promise<string[]> {
  if (run.state !== "active") return [];
  const launching = new Set(
    (await openLaunches(db)).map((launch) => launch.request?.task_id),
  );
  const dispatches = await db.listDispatches(run.run_id);
  const lines: string[] = [];
  for (const task of tasks) {
    if (task.state !== "blocked" || launching.has(task.task_id)) continue;
    const latest = latestDispatch(dispatches, task.task_id);
    if (latest?.settlement !== "stopped") continue;
    const id = latest.dispatch_id;
    const [question] = await questionsOn(db, run, [latest]);
    lines.push(
      `Task ${task.task_id} is blocked on ended Dispatch ${id}: pod retry --dispatch ${id} --generation ${generation}${
        question === undefined
          ? ""
          : `; ${id} left question ${question.message_id} unanswered: answer the new Dispatch's repeat of it with pod reply and the same answer`
      }`,
    );
  }
  return lines;
}

async function gateLines(
  db: Db,
  { run, generation }: Context,
  open: readonly Open[],
  policy: unknown,
): Promise<NextSteps> {
  const candidate =
    (await candidateSha(db, run.run_id)) ??
    "none; the worker_done payload names no head";
  const lines: string[] = [];
  let runnableCount = 0;
  for (const { task, step } of open) {
    if (step.gate === undefined) continue;
    const waiting =
      task.state === "delivered" ||
      (task.state === "ready" && step.type === "human_wait");
    const gate = waiting ? gateOf(policy, step.gate) : null;
    if (gate === null) continue;
    if (gate.type === "HQA")
      lines.push(
        `waiting on ${step.gate} (${gate.keeper}): ${gate.keeper} runs pod hqa record story:${run.story_external_id} --generation ${generation} after the verdict comment`,
      );
    else if (step.type === "worker") {
      lines.push(
        `gate ${step.gate} (AQA, ${gate.keeper}) waits on Task ${task.task_id} at candidate ${candidate}: pod verdict post FILE --generation ${generation}`,
      );
      runnableCount += 1;
    }
  }
  return { lines, runnableCount };
}
