import { hostTranscripts } from "../config/host.ts";
import { dispatch } from "../dispatch/dispatch.ts";
import type { Refusal, Refused } from "../domain/outcome.ts";
import { refuse } from "../domain/outcome.ts";
import type { RetroRunResult } from "../domain/retro.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { CodeHostPort } from "../ports/code-host.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { createTask } from "../process/project.ts";
import { afterClose, ProcessValue } from "../process/schema.ts";
import { readPrs } from "../run/close-effects.ts";
import { dueRun, recordedRetro, retroOpKey } from "./due.ts";
import { retroPacket } from "./packet.ts";

export const retroStep = "retro";

export interface RetroRunInput {
  run: string;
  seat: string;
  generation: number;
  attempt: string;
  host: string;
  capacity: number;
  codeHost: CodeHostPort;
  command: string;
  now: () => Date;
}

export type RetroRunOutcome =
  { ok: true; result: RetroRunResult; opKey: string } | Refused;

function againWith(input: RetroRunInput): string {
  return `${input.command} --op-key <new>`;
}

function retried(refusal: Refusal, again: string): Refused {
  return refuse(refusal.code, refusal.message, [
    again,
    ...refusal.nextSteps.filter((line) => !line.includes("--op-key")),
  ]);
}

export async function retroRun(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: RetroRunInput,
): Promise<RetroRunOutcome> {
  const due = await dueRun(db, input.run);
  if ("ok" in due) return due;
  const { run, archive } = due;
  const tasks = await db.listTasks(run.run_id);
  const existing = tasks.find((task) => task.step_id === retroStep) ?? null;
  const story = `${run.story_provider}:${run.story_external_id}`;

  const recorded = await recordedRetro(db, run.run_id);
  if (recorded !== null)
    return {
      ok: true,
      opKey: retroOpKey(run.run_id),
      result: {
        run_id: run.run_id,
        story,
        state: "recorded",
        task_id: existing?.task_id ?? null,
        dispatch_id: recorded.dispatch_id,
        manifest_id: null,
        op_key: retroOpKey(run.run_id),
        transcripts: [],
        recorded,
        replayed: true,
      },
    };

  if (run.host !== input.host)
    return refuse(
      "wrong_host",
      `Run ${run.run_id} belongs to host ${run.host}, and this retro runs on ${input.host}`,
      [`run ${input.command} on host ${run.host}`],
    );
  const snapshot = await db.getSnapshot(run.run_id);
  const process =
    snapshot === null
      ? null
      : await db.getRevision(snapshot.process_revision_id);
  const step = ProcessValue.safeParse(process?.value).data?.steps.find(
    (row) => row.id === retroStep,
  );
  if (process === null || step === undefined || !afterClose(step))
    return refuse(
      "schema_invalid",
      `the process Revision pinned by Run ${run.run_id} has no ${retroStep} step that runs after close`,
      [
        "apply a process Revision with a retro step; the Run keeps its pinned Revision",
      ],
    );
  if (input.generation !== run.owner_generation)
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );

  const dispatches = (await db.listDispatches(run.run_id)).filter(
    (row) => existing === null || row.task_id !== existing.task_id,
  );
  const reads = await readPrs(
    await db.listEvents(run.run_id, "pr"),
    dispatches,
    archive.worktrees,
    input.codeHost,
  );
  const packet = retroPacket({
    run,
    dispatches,
    prs: reads.map((read) => ({
      number: read.number,
      state: read.state?.state ?? null,
      merge_commit: read.state?.merge_commit ?? null,
    })),
    templates: await hostTranscripts(db, input.host),
  });
  const again = againWith(input);

  let taskId = existing?.task_id ?? null;
  if (taskId === null) {
    const created = await createTask(
      {
        db,
        orca,
        log,
        process,
        host: input.host,
        command: again,
        source: { kind: "command", verb: "retro" },
        now: input.now,
      },
      {
        runId: run.run_id,
        step: {
          id: step.id,
          type: step.type,
          role: step.role ?? null,
          needs: [],
          spec: packet.text,
        },
        opKey: derivedOpKey("project", {
          run_id: run.run_id,
          step_id: retroStep,
          attempt: input.attempt,
        }),
        deps: [],
        reworkOf: null,
        state: "ready",
        onFailure: "keep",
      },
    );
    if (!created.ok)
      return retried(
        {
          ...created.refusal,
          nextSteps: created.refusal.nextSteps.filter(
            (line) => line !== "pod check",
          ),
        },
        again,
      );
    taskId = created.taskId;
  }

  const dispatchKey = derivedOpKey("dispatch", {
    run_id: run.run_id,
    task_id: taskId,
    seat: input.seat,
    attempt: input.attempt,
  });
  const replayed = (await db.getOperation(dispatchKey))?.status === "done";
  const launched = await dispatch(db, orca, log, {
    task: taskId,
    seat: input.seat,
    generation: input.generation,
    opKey: dispatchKey,
    host: input.host,
    capacity: input.capacity,
    command: () => again,
    now: input.now,
  });
  if (!launched.ok) return retried(launched.refusal, again);
  return {
    ok: true,
    opKey: launched.opKey,
    result: {
      run_id: run.run_id,
      story,
      state: "dispatched",
      task_id: taskId,
      dispatch_id: launched.result.dispatch_id,
      manifest_id: launched.result.manifest_id,
      op_key: launched.opKey,
      transcripts: packet.transcripts,
      recorded: null,
      replayed,
    },
  };
}
