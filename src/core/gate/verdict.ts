import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { GateReceipt, Run, Task } from "../domain/ledger.ts";
import { refuse, type Checked, type Refused } from "../domain/outcome.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import {
  followOutcome,
  readProcess,
  recordOutcome,
  type OutcomeResult,
  type Recorded,
} from "../process/project.ts";
import { commentPayload } from "../tracker/outbox.ts";
import {
  candidateSha,
  contentHash,
  gateOf,
  pinnedConfig,
  shaMatches,
} from "./receipt.ts";

export const VerdictFile = z.strictObject({
  gate: z.string().min(1),
  task: z.string().min(1),
  head_sha: z.string().min(1),
  reviewer: z.string().min(1),
  outcome: z.enum(["PASS", "FAIL"]),
  notes: z.string().optional(),
});
export type VerdictFile = z.infer<typeof VerdictFile>;

export interface VerdictInput {
  file: VerdictFile;
  generation: number;
  host: string;
  command: string;
  now: () => Date;
}

export interface VerdictResult extends OutcomeResult {
  receipt_id: number;
  op_key: string;
  gate: string;
  candidate_sha: string;
}

const Seats = z.looseObject({
  seats: z.array(z.looseObject({ id: z.string(), roles: z.array(z.string()) })),
});

const PriorVerdict = z.looseObject({
  receipt_id: z.number(),
  candidate_sha: z.string(),
  outcome: z.enum(["PASS", "FAIL"]),
});

export function verdictBody(file: VerdictFile): string {
  const head = `${file.reviewer}: ${file.gate} ${file.outcome}\nHead: ${file.head_sha}`;
  return file.notes === undefined ? head : `${head}\n\n${file.notes}`;
}

function notReady(message: string, steps: string[]): Refused {
  return refuse("task_not_ready", message, steps);
}

async function independence(
  tx: Repo,
  task: Task,
  needs: readonly string[],
  reviewer: string,
): Promise<Refused | null> {
  const needed = new Set(
    (await tx.listTasks(task.run_id))
      .filter((row) => needs.includes(row.step_id))
      .map((row) => row.task_id),
  );
  const authored = (await tx.listDispatches(task.run_id)).find(
    (row) =>
      needed.has(row.task_id) &&
      (row.settlement === "done" || row.settlement === "failed") &&
      row.seat === reviewer,
  );
  if (authored === undefined) return null;
  return refuse(
    "reviewer_not_independent",
    `reviewer ${reviewer} is the seat ${authored.seat} of Dispatch ${authored.dispatch_id}, which delivered Task ${authored.task_id}`,
    [`post the verdict from a ${task.role} seat other than ${authored.seat}`],
  );
}

async function evidence(
  tx: Repo,
  run: Run,
  task: Task,
  file: VerdictFile,
): Promise<{ candidate: string } | Refused> {
  if (task.state !== "delivered")
    return notReady(`Task ${task.task_id} is ${task.state}, not delivered`, [
      `Task state ${task.state}`,
    ]);
  const { step } = await readProcess(tx, task, file.outcome);
  if (step.gate !== file.gate)
    return notReady(
      `Task ${task.task_id}'s step ${step.id} has gate ${step.gate ?? "none"}, not ${file.gate}`,
      [`set gate to ${step.gate ?? "the step's gate"} or name another Task`],
    );
  const candidate = await candidateSha(tx, run.run_id);
  if (candidate === null)
    return refuse(
      "receipt_stale_sha",
      `Run ${run.run_id} has no candidate SHA: no push event is recorded`,
      [
        "record the worker's push with a worker_done payload head, then request a review of that SHA",
      ],
    );
  if (!shaMatches(file.head_sha, candidate))
    return refuse(
      "receipt_stale_sha",
      `head_sha ${file.head_sha} is not the candidate SHA ${candidate}`,
      [`request a new review of the candidate SHA ${candidate}`],
    );
  const pinned = await pinnedConfig(tx, run.run_id);
  const seats = Seats.safeParse(pinned?.crew).data?.seats ?? [];
  const seat = seats.find((row) => row.id === file.reviewer);
  if (seat === undefined || !seat.roles.includes(task.role))
    return refuse(
      "role_unfilled",
      `reviewer ${file.reviewer} is not a seat with role ${task.role} in the Run's crew`,
      [`name a seat that holds role ${task.role}`],
    );
  const refused = await independence(tx, task, step.needs, file.reviewer);
  if (refused !== null) return refused;
  const gate = gateOf(pinned?.policy, file.gate);
  if (gate === null)
    return notReady(
      `gate ${file.gate} has no keeper and type in the Run's policy`,
      [`give gate ${file.gate} a keeper and a type in the policy`],
    );
  if (gate.type !== "AQA")
    return notReady(`gate ${file.gate} is HQA`, [
      `pod hqa record story:${run.story_external_id} --generation ${run.owner_generation}`,
    ]);
  return { candidate };
}

type Written =
  | Refused
  | { ok: true; recorded: Recorded; receipt_id: number; candidate: string };

async function write(
  tx: Repo,
  input: VerdictInput,
  opKey: string,
): Promise<Written> {
  const { file } = input;
  const task = await tx.getTask(file.task);
  if (task === null) return notReady(`no Task ${file.task}`, ["pod brief"]);
  const run = await tx.lockRun(task.run_id);
  if (run === null) return notReady(`no Run ${task.run_id}`, ["pod brief"]);
  if (run.owner_generation !== input.generation)
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );
  const at = input.now();
  const outcomeInput = {
    task: task.task_id,
    outcome: file.outcome,
    at,
    host: input.host,
  };
  const prior = await tx.getOperation(opKey);
  if (prior !== null) {
    const ref = PriorVerdict.safeParse(prior.result_ref);
    if (prior.status !== "done" || !ref.success)
      return refuse("duplicate_op", `op key ${opKey} has no recorded verdict`, [
        "pod brief",
      ]);
    if (ref.data.outcome !== file.outcome)
      return refuse(
        "duplicate_op",
        `op key ${opKey} recorded ${ref.data.outcome}, not ${file.outcome}`,
        [`request a new review of the candidate SHA ${ref.data.candidate_sha}`],
      );
    const recorded = await recordOutcome(tx, {
      ...outcomeInput,
      source: { kind: "receipt", receipt_id: ref.data.receipt_id },
    });
    return {
      ok: true,
      recorded: { ...recorded, replayed: true },
      receipt_id: ref.data.receipt_id,
      candidate: ref.data.candidate_sha,
    };
  }
  const checked = await evidence(tx, run, task, file);
  if ("ok" in checked) return checked;
  const body = verdictBody(file);
  await tx.insertOperation({
    op_key: opKey,
    intent: "verdict",
    owner_generation: run.owner_generation,
    at,
  });
  const receipt: GateReceipt = await tx.insertGateReceipt({
    gate_id: file.gate,
    run_id: run.run_id,
    task_id: task.task_id,
    scope: "task",
    spec_revision_id: task.spec_revision_id,
    candidate_sha: checked.candidate,
    deployed_revision: null,
    keeper: file.reviewer,
    outcome: file.outcome,
    source: {
      kind: "verdict_file",
      reviewer: file.reviewer,
      content_hash: contentHash(body),
      op_key: opKey,
    },
    sync_state: "pending",
    created_at: at,
  });
  await tx.enqueueOutbox({
    op_key: opKey,
    target: "tracker",
    payload: commentPayload(
      { provider: run.story_provider, external_id: run.story_external_id },
      body,
    ),
  });
  await tx.appendEvent({
    type: "receipt",
    ts: at,
    host: input.host,
    run_id: run.run_id,
    task_id: task.task_id,
    dispatch_id: null,
    op_key: opKey,
    payload: {
      receipt_id: receipt.id,
      gate: file.gate,
      outcome: file.outcome,
      candidate_sha: checked.candidate,
    },
    source: { kind: "command", verb: "verdict post" },
  });
  const recorded = await recordOutcome(tx, {
    ...outcomeInput,
    source: { kind: "receipt", receipt_id: receipt.id },
  });
  await tx.moveOperation(
    opKey,
    "done",
    Json.parse({
      receipt_id: receipt.id,
      task_id: task.task_id,
      candidate_sha: checked.candidate,
      outcome: file.outcome,
    }),
    at,
  );
  return {
    ok: true,
    recorded,
    receipt_id: receipt.id,
    candidate: checked.candidate,
  };
}

export async function postVerdict(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: VerdictInput,
): Promise<Checked<VerdictResult>> {
  const { version } = await orca.version();
  const { file } = input;
  const task = await db.getTask(file.task);
  const opKey = derivedOpKey("verdict", {
    run_id: task?.run_id ?? "",
    task_id: file.task,
    gate: file.gate,
    head_sha: file.head_sha,
    reviewer: file.reviewer,
  });
  const written = await db.transaction((tx) => write(tx, input, opKey));
  if (!written.ok) return written;
  const followed = await followOutcome(db, orca, log, written.recorded, {
    task: file.task,
    outcome: file.outcome,
    at: input.now(),
    host: input.host,
    source: { kind: "receipt", receipt_id: written.receipt_id },
    command: input.command,
    now: input.now,
    version,
  });
  if (!followed.ok) return followed;
  return {
    ok: true,
    orca: version,
    result: {
      ...followed.result,
      receipt_id: written.receipt_id,
      op_key: opKey,
      gate: file.gate,
      candidate_sha: written.candidate,
    },
  };
}

const VerdictSource = z.looseObject({
  kind: z.literal("verdict_file"),
  op_key: z.string(),
});

export async function syncVerdictReceipts(
  db: Db,
  runId: string,
): Promise<number[]> {
  const synced: number[] = [];
  for (const receipt of await db.listGateReceipts(runId)) {
    if (receipt.sync_state !== "pending") continue;
    const source = VerdictSource.safeParse(receipt.source);
    if (!source.success) continue;
    const row = await db.outboxByOpKey(source.data.op_key);
    if (row?.acked_at == null) continue;
    await db.setGateReceiptSync(receipt.id, "synced");
    synced.push(receipt.id);
  }
  return synced;
}
