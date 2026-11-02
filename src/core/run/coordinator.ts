import type { Revision } from "../domain/config.ts";
import type { Run } from "../domain/ledger.ts";
import type { Refusal } from "../domain/outcome.ts";
import { renderTemplate, templateOf, Templates } from "../decide/templates.ts";
import {
  openDecisionSeat,
  type SeatOutcome,
  type SeatRole,
} from "../dispatch/decision-seats.ts";
import type { ReceiptLog } from "../ledger/receipts.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";

export interface PairInput {
  templates: Revision | null;
  host: string;
  capacity: number;
  now: () => Date;
}

export interface SeatRefusal {
  role: SeatRole;
  code: Refusal["code"];
  message: string;
  nextSteps: string[];
}

export function seatRefusal(role: SeatRole, refusal: Refusal): SeatRefusal {
  return {
    role,
    code: refusal.code,
    message: refusal.message,
    nextSteps: refusal.nextSteps,
  };
}

function noTemplates(): SeatOutcome {
  return {
    ok: false,
    refusal: {
      code: "revision_not_found",
      message: "no active decision Revision for the Run's scope",
      nextSteps: [
        "pod config apply specs/decision/default.yaml --activate --scope global --expected-revision none",
      ],
    },
  };
}

async function runFields(db: Db, run: Run, generation: number) {
  const snapshot = await db.getSnapshot(run.run_id);
  const process =
    snapshot === null
      ? null
      : await db.getRevision(snapshot.process_revision_id);
  return {
    story: `story:${run.story_external_id}`,
    process: process === null ? "" : `process.${process.name}@${process.rev}`,
    run_id: run.run_id,
    generation: String(generation),
    check: `pod check --run ${run.run_id} --generation ${generation}`,
  };
}

export async function openCoordinator(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: PairInput & {
    run: Run;
    generation: number;
    viewPath: string;
    manifestId: string;
    relaunch: number;
  },
): Promise<SeatOutcome> {
  const templates = Templates.safeParse(input.templates?.value);
  if (!templates.success) return noTemplates();
  const fields = {
    ...(await runFields(db, input.run, input.generation)),
    view_path: input.viewPath,
  };
  const seat = await openDecisionSeat(db, orca, log, {
    run: input.run,
    decisionId: null,
    role: "decider",
    spec: renderTemplate(
      templateOf(templates.data, "coordinator_open"),
      fields,
    ),
    manifestId: input.manifestId,
    generation: input.generation,
    host: input.host,
    capacity: input.capacity,
    now: input.now,
    relaunch: input.relaunch,
  });
  if (!seat.ok) return seat;
  await db.setRunCoordinator(input.run.run_id, {
    generation: input.generation,
    dispatch_id: seat.dispatch.dispatch_id,
    coordinator: seat.dispatch.terminal_handle ?? input.run.coordinator,
  });
  return seat;
}

export async function openResidentAuditor(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  input: PairInput & {
    run: Run;
    manifestId: string;
    decider: string;
  },
): Promise<SeatOutcome> {
  const templates = Templates.safeParse(input.templates?.value);
  if (!templates.success) return noTemplates();
  const fields = await runFields(db, input.run, input.run.owner_generation);
  return openDecisionSeat(db, orca, log, {
    run: input.run,
    decisionId: null,
    role: "auditor",
    spec: renderTemplate(templates.data.auditor, {
      ...fields,
      decision_id: "",
      question: `Audit the Decisions of Run ${input.run.run_id} for ${fields.story}.`,
      options: "",
      manifest_id: input.manifestId,
      manifest: "",
    }),
    manifestId: input.manifestId,
    generation: input.run.owner_generation,
    host: input.host,
    capacity: input.capacity,
    now: input.now,
    handoff: input.decider,
  });
}
