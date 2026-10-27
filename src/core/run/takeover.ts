import { z } from "zod";
import { Json } from "../domain/json.ts";
import type { Operation, Run } from "../domain/ledger.ts";
import {
  refuse,
  RefusalCode,
  type Outcome,
  type Refusal,
} from "../domain/outcome.ts";
import { launchOutcome, stopOnOpen } from "../ledger/launch.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import { renderRestoreHtml } from "../manifest/html.ts";
import { recordManifest } from "../manifest/record.ts";
import {
  revisionReference,
  runReference,
  storyReference,
  taskReference,
} from "../manifest/references.ts";
import { renderRestoreView, restoreView } from "../manifest/restore-view.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { OrcaPort, Receipt, TerminalShowResult } from "../ports/orca.ts";

export interface TakeoverInput {
  story: string;
  provider: string;
  generation: number;
  coordinator: string;
  opKey: string | null;
  viewPath: (runId: string, generation: number) => string;
  host: string;
  command: (opKey: string) => string;
  now: () => Date;
}

export const TakeoverRequest = z.looseObject({
  run_id: z.string(),
  story: z.string(),
  from_handle: z.string(),
  to_handle: z.string(),
  generation: z.int(),
  view_path: z.string(),
});
export type TakeoverRequest = z.infer<typeof TakeoverRequest>;

const Taken = z.object({
  run_id: z.string(),
  story: z.string(),
  owner_generation: z.int(),
  coordinator: z.string(),
  previous_coordinator: z.string(),
  consumer_generation: z.int(),
  manifest_id: z.string(),
  view_path: z.string(),
});
type Taken = z.infer<typeof Taken>;

export interface TakeoverResult extends Taken {
  restore_view: string;
  nextSteps: string[];
}

export const TakeoverRecorded = z.looseObject({
  request: TakeoverRequest,
  outcome: z.enum(["taken", "failed"]).optional(),
  result: Taken.optional(),
  requestId: z.string().nullish(),
  code: RefusalCode.optional(),
  message: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
});

const ErrorCode = z.looseObject({
  error: z.looseObject({ code: z.string() }),
});

export function coordinatorStopped(
  receipt: Receipt<TerminalShowResult>,
): boolean {
  if (receipt.exitCode !== 0)
    return (
      ErrorCode.safeParse(receipt.raw).data?.error.code ===
      "terminal_handle_stale"
    );
  const terminal = receipt.result?.terminal;
  return terminal?.connected === false && terminal.exitCause != null;
}

function failedRow(row: Operation): boolean {
  return TakeoverRecorded.safeParse(row.result_ref).data?.outcome === "failed";
}

async function takeoverKey(
  repo: Repo,
  runId: string,
  generation: number,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const opKey = derivedOpKey("takeover", {
      run_id: runId,
      generation: String(generation),
      attempt: String(attempt),
    });
    const row = await repo.getOperation(opKey);
    if (row === null) return opKey;
    if (row.status === "refused") continue;
    if (row.status === "done" && failedRow(row)) continue;
    return opKey;
  }
}

export function checkStep(runId: string, generation: number): string {
  return `pod check --run ${runId} --generation ${generation}`;
}

function staleRefusal(run: Run, generation: number): Refusal {
  return {
    code: "owner_generation_stale",
    message: `--generation ${generation} differs from the Run's owner generation ${run.owner_generation}`,
    nextSteps: [
      `pod takeover story:${run.story_external_id} if this session should own the Run`,
    ],
  };
}

async function readEvidence(
  orca: OrcaPort,
  run: Run,
): Promise<{ live: string[]; readable: boolean }> {
  const shown = await orca.runShow({ run: run.run_id });
  if (shown.exitCode !== 0 || shown.result === null)
    return { live: [run.coordinator], readable: false };
  const handles = [
    ...new Set([run.coordinator, shown.result.run.coordinator_handle]),
  ];
  const live: string[] = [];
  for (const handle of handles)
    if (!coordinatorStopped(await orca.terminalShow({ terminal: handle })))
      live.push(handle);
  return { live, readable: true };
}

function unsafe(live: readonly string[], readable: boolean): Refusal {
  return {
    code: "takeover_unsafe",
    message: readable
      ? `the old coordinator ${live.join(", ")} has not stopped`
      : "run-show gave no readable reply, so the old coordinator is not known to have stopped",
    nextSteps: [
      ...live.map((handle) => `orca terminal close --terminal ${handle}`),
      "evidence accepted: terminal show reports connected false with an exitCause, or terminal_handle_stale, for every coordinator handle",
    ],
  };
}

export type Recorded =
  { kind: "taken"; taken: Taken } | { kind: "stale"; refusal: Refusal };

export async function recordTakeover(
  db: Db,
  record: {
    opKey: string;
    request: TakeoverRequest;
    consumerGeneration: number;
    host: string;
    verb: "takeover" | "check";
    at: Date;
  },
): Promise<Recorded> {
  const { opKey, request, at } = record;
  return db.transaction(async (tx): Promise<Recorded> => {
    const current = TakeoverRecorded.safeParse(
      (await tx.getOperation(opKey))?.result_ref,
    );
    if (current.success && current.data.result !== undefined)
      return { kind: "taken", taken: current.data.result };
    const next = request.generation + 1;
    const moved = await tx.advanceOwner(request.run_id, {
      from: request.generation,
      to: next,
      coordinator: request.to_handle,
    });
    const run = await tx.getRun(request.run_id);
    if (run === null) throw new Error(`Run ${request.run_id} vanished`);
    if (!moved) {
      const refusal: Refusal = {
        code: "owner_generation_stale",
        message: `takeover at generation ${request.generation} lost the race; the Run's owner generation is ${run.owner_generation} and its coordinator is ${run.coordinator}`,
        nextSteps: [
          `pod takeover story:${request.story} --generation ${run.owner_generation} from this terminal if this session should still own the Run`,
        ],
      };
      await tx.moveOperation(
        opKey,
        "refused",
        Json.parse({ request, ...refusal }),
        at,
      );
      return { kind: "stale", refusal };
    }
    const story = await tx.getStory(run.story_provider, run.story_external_id);
    const snapshot = await tx.getSnapshot(run.run_id);
    if (story === null || snapshot === null)
      throw new Error(`Run ${run.run_id} lost its Story or Snapshot`);
    const revisions = [];
    for (const id of [
      snapshot.crew_revision_id,
      snapshot.process_revision_id,
      snapshot.policy_revision_id,
    ]) {
      const revision = await tx.getRevision(id);
      if (revision === null)
        throw new Error(`Run ${run.run_id} lost a pinned Revision`);
      revisions.push(revisionReference(revision));
    }
    const { manifest } = await recordManifest(tx, {
      run_id: run.run_id,
      task_id: null,
      decision_id: null,
      parent_id: null,
      created_at: at,
      references: [
        storyReference(story),
        runReference(run),
        ...(await tx.listTasks(run.run_id)).map(taskReference),
        ...revisions,
      ],
    });
    const taken: Taken = {
      run_id: run.run_id,
      story: request.story,
      owner_generation: next,
      coordinator: request.to_handle,
      previous_coordinator: request.from_handle,
      consumer_generation: record.consumerGeneration,
      manifest_id: manifest.id,
      view_path: request.view_path,
    };
    await tx.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "taken", result: taken }),
      at,
    );
    await tx.appendEvent({
      type: "takeover",
      ts: at,
      host: record.host,
      run_id: run.run_id,
      task_id: null,
      dispatch_id: null,
      op_key: opKey,
      payload: Json.parse({
        op_key: opKey,
        previous_coordinator: request.from_handle,
        coordinator: request.to_handle,
        previous_generation: request.generation,
        owner_generation: next,
        consumer_generation: record.consumerGeneration,
        view_path: request.view_path,
        manifest_id: manifest.id,
      }),
      source: { kind: "command", verb: record.verb },
    });
    return { kind: "taken", taken };
  });
}

async function finished(
  db: Db,
  taken: Taken,
  opKey: string,
  version: string,
): Promise<Outcome<TakeoverResult>> {
  const nextSteps = [checkStep(taken.run_id, taken.owner_generation)];
  const view = await restoreView(
    db,
    taken.run_id,
    taken.manifest_id,
    nextSteps,
  );
  return {
    ok: true,
    result: {
      ...taken,
      restore_view: renderRestoreHtml(renderRestoreView(view)),
      nextSteps,
    },
    opKey,
    orca: version,
  };
}

function duplicate(opKey: string) {
  return refuse(
    "duplicate_op",
    `op key ${opKey} belongs to another intent or request`,
    ["pass a new --op-key"],
  );
}

export async function takeover(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: TakeoverInput,
): Promise<Outcome<TakeoverResult>> {
  const story = await db.getStory(input.provider, input.story);
  const run = story?.run_id == null ? null : await db.getRun(story.run_id);
  if (run === null)
    return refuse("story_not_found", `no Run for story:${input.story}`, [
      "pod brief",
    ]);
  const { version } = await orca.version();
  const opKey =
    input.opKey ?? (await takeoverKey(db, run.run_id, input.generation));
  const context = { run_id: run.run_id, task_id: null, op_key: opKey };

  const existing = await db.getOperation(opKey);
  if (existing !== null) {
    const ref = TakeoverRecorded.safeParse(existing.result_ref);
    if (
      existing.intent !== "takeover" ||
      !ref.success ||
      ref.data.request.run_id !== run.run_id
    )
      return duplicate(opKey);
    if (existing.status === "pending" || existing.status === "unknown")
      return stopOnOpen(orca, log, context, existing, input.command(opKey));
    if (ref.data.result !== undefined)
      return finished(db, ref.data.result, opKey, version);
    if (existing.status === "refused")
      return refuse(
        ref.data.code ?? "failed",
        ref.data.message ?? `op key ${opKey} was refused`,
        ref.data.nextSteps ?? [],
      );
    return refuse("failed", `run-use under op key ${opKey} failed before`, [
      `pod takeover story:${input.story} --generation ${input.generation}`,
    ]);
  }

  log.at(context);
  const evidence = await readEvidence(orca, run);
  const request: TakeoverRequest = {
    run_id: run.run_id,
    story: input.story,
    from_handle: run.coordinator,
    to_handle: input.coordinator,
    generation: input.generation,
    view_path: input.viewPath(run.run_id, input.generation + 1),
  };
  const now = input.now();
  const gate = await db.transaction(async (tx): Promise<Refusal | null> => {
    const current = await tx.getRun(run.run_id);
    if (current === null) throw new Error(`Run ${run.run_id} vanished`);
    const record = async (refusal: Refusal) => {
      const { created } = await tx.insertOperation({
        op_key: opKey,
        intent: "takeover",
        owner_generation: input.generation,
        at: now,
        result_ref: Json.parse({ request }),
      });
      if (created)
        await tx.moveOperation(
          opKey,
          "refused",
          Json.parse({ request, ...refusal }),
          now,
        );
      return refusal;
    };
    if (input.generation !== current.owner_generation)
      return record(staleRefusal(current, input.generation));
    if (!evidence.readable || evidence.live.length > 0)
      return record(unsafe(evidence.live, evidence.readable));
    const { created } = await tx.insertOperation({
      op_key: opKey,
      intent: "takeover",
      owner_generation: input.generation,
      at: now,
      result_ref: Json.parse({ request }),
    });
    return created
      ? null
      : {
          code: "duplicate_op",
          message: `op key ${opKey} was taken by another call`,
          nextSteps: [input.command(opKey)],
        };
  });
  if (gate !== null) return { ok: false, refusal: gate };

  const receipt = await orca.runUse({
    run: run.run_id,
    from: input.coordinator,
  });
  const outcome = launchOutcome(receipt);
  const at = input.now();
  if (outcome.kind === "ok" && receipt.result !== null) {
    const recorded = await recordTakeover(db, {
      opKey,
      request,
      consumerGeneration: receipt.result.run.consumer_generation,
      host: input.host,
      verb: "takeover",
      at,
    });
    if (recorded.kind === "stale")
      return { ok: false, refusal: recorded.refusal };
    return finished(db, recorded.taken, opKey, version);
  }
  if (outcome.kind === "failed") {
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ request, outcome: "failed", raw: receipt.raw ?? null }),
      at,
    );
    return refuse("failed", `run-use for Run ${run.run_id} failed`, [
      ErrorCode.safeParse(receipt.raw).data?.error.code ??
        "Orca gave no readable reply",
      `pod takeover story:${input.story} --generation ${input.generation}`,
    ]);
  }
  await db.moveOperation(
    opKey,
    "unknown",
    Json.parse({
      request,
      requestId: outcome.kind === "unknown" ? outcome.requestId : null,
    }),
    at,
  );
  return refuse(
    "launch_unknown",
    `run-use for Run ${run.run_id} has no known outcome`,
    [input.command(opKey), checkStep(run.run_id, input.generation)],
  );
}
