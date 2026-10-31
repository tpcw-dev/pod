import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Dispatch, Run } from "../domain/ledger.ts";
import { refuse, RefusalCode, type Refusal } from "../domain/outcome.ts";
import { launchOutcome, stopOnOpen } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { seatLaunch } from "./dispatch.ts";
import { drainRefusal, slotRefusal } from "./launch-gate.ts";
import {
  attribution,
  fromReceipt,
  insertStart,
  requestedLaunch,
  LaunchArgs,
  type Launched,
} from "./launch-record.ts";
import { openLaunches } from "./quota.ts";
import { readSeats, SeatsInvalid, type Seat } from "./seats.ts";

export type { ReceiptLog } from "../ledger/receipts.ts";

export type SeatRole = "decider" | "auditor";

export function decideOpKey(fields: {
  run_id: string;
  task_id: string;
  category: string;
}): string {
  return derivedOpKey("decide", fields);
}

export function decisionIdOf(opKey: string): string {
  return `dec_${opKey.slice(opKey.indexOf(":") + 1)}`;
}

export function seatOpKey(runId: string, role: SeatRole, decisionId: string) {
  return derivedOpKey("decide_seat", {
    run_id: runId,
    role,
    decision_id: decisionId,
  });
}

const IndependentOf = z.looseObject({
  independent_of: z.array(z.string()).optional(),
});

export function pickSeat(
  seats: readonly Seat[],
  role: SeatRole,
): { seat: Seat } | { refusal: Refusal } {
  const decider = seats.find((seat) => seat.roles.includes("decider"));
  if (role === "decider")
    return decider === undefined ? unfilled("decider") : { seat: decider };
  const auditors = seats.filter((seat) => seat.roles.includes("auditor"));
  const [first] = auditors;
  if (first === undefined) return unfilled("auditor");
  const auditor = auditors.find((seat) => seat.id !== decider?.id);
  if (auditor === undefined)
    return {
      refusal: {
        code: "reviewer_not_independent",
        message: `the auditor Seat ${first.id} is also the decider Seat`,
        nextSteps: [
          "pod config apply crew.yaml with an auditor Seat apart from the decider",
        ],
      },
    };
  const named = IndependentOf.safeParse(auditor).data?.independent_of;
  if (
    named !== undefined &&
    decider !== undefined &&
    !named.includes(decider.id)
  )
    return {
      refusal: {
        code: "reviewer_not_independent",
        message: `auditor Seat ${auditor.id} is not independent_of decider Seat ${decider.id}`,
        nextSteps: [
          `add ${decider.id} to independent_of of Seat ${auditor.id}`,
        ],
      },
    };
  return { seat: auditor };
}

function unfilled(role: SeatRole): { refusal: Refusal } {
  return {
    refusal: {
      code: "role_unfilled",
      message: `no crew Seat holds role ${role}`,
      nextSteps: [
        `role ${role}`,
        "pod config apply crew.yaml with a Seat that fills it",
      ],
    },
  };
}

export interface SeatInput {
  run: Run;
  decisionId: string;
  role: SeatRole;
  spec: string;
  manifestId: string;
  generation: number;
  host: string;
  capacity: number;
  now: () => Date;
}

export type SeatOutcome =
  | { ok: true; dispatch: Dispatch; reused: boolean }
  | { ok: false; refusal: Refusal };

const SeatRequest = z.looseObject({
  decision_id: z.string(),
  role: z.enum(["decider", "auditor"]),
  seat: z.string(),
  host: z.string(),
});

export const SeatRef = z.looseObject({
  request: SeatRequest,
  launch: z.looseObject({ agent: z.string() }),
  spec: z.string(),
  manifest_id: z.string(),
  orca_task: z.string(),
  requestId: z.string().nullish(),
});
export type SeatRef = z.infer<typeof SeatRef>;

const Done = z.looseObject({
  result: z.looseObject({ dispatch_id: z.string() }).optional(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

export function openSeat(dispatches: readonly Dispatch[], role: SeatRole) {
  return dispatches.find(
    (row) =>
      row.decision_id !== null &&
      row.role === role &&
      row.settlement === "open",
  );
}

export async function openDecisionSeat(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: SeatInput,
): Promise<SeatOutcome> {
  const { run } = input;
  const reuse = openSeat(await db.listDispatches(run.run_id), input.role);
  if (reuse !== undefined) return { ok: true, dispatch: reuse, reused: true };
  const snapshot = await db.getSnapshot(run.run_id);
  const crew =
    snapshot === null ? null : await db.getRevision(snapshot.crew_revision_id);
  if (crew === null)
    return refuse("task_not_ready", `Run ${run.run_id} has no pinned crew`, [
      "pod brief",
    ]);
  let seats: Seat[];
  try {
    seats = readSeats(crew.value);
  } catch (error) {
    if (!(error instanceof SeatsInvalid)) throw error;
    return refuse("schema_invalid", error.message, [error.path]);
  }
  const picked = pickSeat(seats, input.role);
  if ("refusal" in picked) return { ok: false, refusal: picked.refusal };
  const { seat } = picked;
  const opKey = seatOpKey(run.run_id, input.role, input.decisionId);
  const launch: LaunchArgs = seatLaunch(seat);
  const request = {
    decision_id: input.decisionId,
    role: input.role,
    seat: seat.id,
    host: input.host,
  };
  const now = input.now();
  const context = { run_id: run.run_id, task_id: null, op_key: opKey };

  type Gate =
    | { kind: "launch" }
    | { kind: "refused"; refusal: Refusal }
    | { kind: "open"; status: "pending" | "unknown"; ref: Json | null }
    | { kind: "done"; dispatchId: string | null };
  const gate = await db.transaction(async (tx): Promise<Gate> => {
    await tx.lockQuota(input.host);
    const existing = await tx.getOperation(opKey);
    if (existing !== null) {
      if (existing.status === "pending" || existing.status === "unknown")
        return {
          kind: "open",
          status: existing.status,
          ref: existing.result_ref,
        };
      const done = Done.safeParse(existing.result_ref).data;
      if (existing.status === "refused")
        return {
          kind: "refused",
          refusal: {
            code: done?.code ?? "failed",
            message: done?.message ?? `op key ${opKey} was refused`,
            nextSteps: done?.nextSteps ?? [],
          },
        };
      return { kind: "done", dispatchId: done?.result?.dispatch_id ?? null };
    }
    const found = await seatRefusal(tx, input);
    await tx.insertOperation({
      op_key: opKey,
      intent: "decide_seat",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({
        request,
        launch,
        spec: input.spec,
        manifest_id: input.manifestId,
      }),
    });
    if (found === null) return { kind: "launch" };
    await tx.moveOperation(
      opKey,
      "refused",
      Json.parse({ request, ...found }),
      now,
    );
    return { kind: "refused", refusal: found };
  });

  if (gate.kind === "refused") return { ok: false, refusal: gate.refusal };
  if (gate.kind === "open")
    return stopOnOpen(
      orca,
      log,
      context,
      { op_key: opKey, status: gate.status, result_ref: gate.ref },
      `pod check --run ${run.run_id} --generation ${input.generation}`,
    );
  if (gate.kind === "done") {
    const row =
      gate.dispatchId === null ? null : await db.getDispatch(gate.dispatchId);
    return row === null
      ? refuse("failed", `worker-start under op key ${opKey} failed before`, [
          "pod check",
        ])
      : { ok: true, dispatch: row, reused: true };
  }

  log.at(context);
  const created = await orca.taskCreate({
    spec: input.spec,
    run: run.run_id,
    taskTitle: `decision ${input.role}`,
  });
  const orcaTask =
    launchOutcome(created).kind === "ok"
      ? (created.result?.task.id ?? null)
      : null;
  if (orcaTask === null) {
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "failed", raw: created.raw ?? null }),
      input.now(),
    );
    return refuse("failed", `task-create for the ${input.role} Seat failed`, [
      "pod check",
    ]);
  }
  const receipt = await orca.workerStart({
    task: orcaTask,
    run: run.run_id,
    ...launch,
  });
  const outcome = launchOutcome(receipt);
  const launched =
    outcome.kind === "ok" && receipt.result !== null
      ? fromReceipt(receipt.result)
      : null;
  const ref: SeatRef = {
    request,
    launch,
    spec: input.spec,
    manifest_id: input.manifestId,
    orca_task: orcaTask,
  };
  const at = input.now();
  if (launched !== null) {
    const dispatchId = await db.transaction(async (tx) => {
      await tx.lockQuota(input.host);
      return recordSeatStarted(tx, { opKey, ref, run, launched, at });
    });
    const row = await db.getDispatch(dispatchId);
    if (row === null) throw new Error(`Dispatch ${dispatchId} vanished`);
    return { ok: true, dispatch: row, reused: false };
  }
  if (outcome.kind === "failed") {
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "failed", raw: receipt.raw ?? null }),
      at,
    );
    return refuse("failed", `worker-start for the ${input.role} Seat failed`, [
      ...(receipt.result?.lastError == null ? [] : [receipt.result.lastError]),
      "pod check",
    ]);
  }
  await recordSeatUnknown(
    db,
    opKey,
    ref,
    outcome.kind === "unknown" ? outcome.requestId : null,
    at,
  );
  return refuse(
    "launch_unknown",
    `worker-start for the ${input.role} Seat has no known outcome`,
    [`pod check --run ${run.run_id} --generation ${input.generation}`],
  );
}

async function seatRefusal(
  tx: Repo,
  input: SeatInput,
): Promise<Refusal | null> {
  const drained = await drainRefusal(tx, input.run.run_id);
  if (drained !== null) return drained;
  const run = await tx.getRun(input.run.run_id);
  if (run?.state !== "active")
    return {
      code: "task_not_ready",
      message: `Run ${input.run.run_id} is ${run?.state ?? "missing"}`,
      nextSteps: [`Run state ${run?.state ?? "missing"}`],
    };
  return slotRefusal(tx, input.host, input.capacity, await openLaunches(tx));
}

export async function recordSeatStarted(
  tx: Repo,
  input: {
    opKey: string;
    ref: SeatRef;
    run: Pick<Run, "run_id">;
    launched: Launched;
    at: Date;
  },
): Promise<string> {
  const { ref, launched } = input;
  const result = {
    dispatch_id: launched.dispatchId,
    decision_id: ref.request.decision_id,
    role: ref.request.role,
    seat: ref.request.seat,
  };
  const launch = LaunchArgs.parse(ref.launch);
  await tx.moveOperation(
    input.opKey,
    "done",
    Json.parse({ ...ref, result }),
    input.at,
  );
  if ((await tx.getDispatch(launched.dispatchId)) !== null)
    return launched.dispatchId;
  await insertStart(tx, {
    owner: { task_id: null, decision_id: ref.request.decision_id },
    run_id: input.run.run_id,
    role: ref.request.role,
    seat: ref.request.seat,
    host: ref.request.host,
    launched,
    requested_launch: requestedLaunch(launched, launch),
    model_attribution: attribution(launched),
    retry_of: null,
    op_key: input.opKey,
    manifest_id: ref.manifest_id,
    verb: "decide",
    late: false,
    at: input.at,
  });
  return launched.dispatchId;
}

export async function recordSeatUnknown(
  db: Db,
  opKey: string,
  ref: SeatRef,
  requestId: string | null,
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.lockQuota(ref.request.host);
    if ((await tx.getOperation(opKey))?.status !== "pending") return;
    await tx.moveOperation(
      opKey,
      "unknown",
      Json.parse({ ...ref, requestId }),
      at,
    );
  });
}
