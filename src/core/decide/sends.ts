import { z } from "zod";
import type { DecisionRow } from "../domain/decision.ts";
import { Json } from "../domain/json.ts";
import type { Run } from "../domain/ledger.ts";
import {
  openDecisionSeat,
  type ReceiptLog,
  type SeatRole,
} from "../dispatch/decision-seats.ts";
import { ManifestReference, manifestText } from "../manifest/references.ts";
import type { Db } from "../ports/db.ts";
import type { OrcaPort } from "../ports/orca.ts";
import { failDecision, proposalOf } from "./advance.ts";
import { OwedSend, type FollowUp } from "./owed.ts";
import {
  optionsText,
  renderTemplate,
  templateOf,
  type Templates,
} from "./templates.ts";

export interface FollowContext {
  run: Run;
  templates: Templates | null;
  generation: number;
  host: string;
  capacity: number;
  now: () => Date;
}

interface Owed {
  opKey: string;
  item: FollowUp;
}

async function owedSends(db: Db, run: Run): Promise<Owed[]> {
  const owed: Owed[] = [];
  for (const operation of await db.listOperations(["decide"], ["pending"])) {
    const ref = OwedSend.safeParse(operation.result_ref);
    if (!ref.success || ref.data.request.run_id !== run.run_id) continue;
    owed.push({ opKey: operation.op_key, item: ref.data.follow_up });
  }
  return owed;
}

function expectedState(item: FollowUp): string {
  return item.kind === "evidence_request"
    ? `awaiting_evidence:${item.round}`
    : `round:${item.round}`;
}

const suffix: Record<FollowUp["kind"], string> = {
  proposal: " proposal",
  round_next: "",
  evidence_request: " evidence request",
  round_evidence: " evidence",
  resume: " resume",
};

export async function followDecisions(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  context: FollowContext,
): Promise<string[]> {
  const steps: string[] = [];
  for (const { opKey, item } of await owedSends(db, context.run)) {
    const decision = await db.getDecision(item.decision_id);
    if (decision === null || decision.state !== expectedState(item)) {
      await db.moveOperation(
        opKey,
        "refused",
        Json.parse({
          code: "settled_decision",
          message: `Decision ${item.decision_id} is ${decision?.state ?? "gone"}; the ${item.kind} send of round ${item.round} is not owed`,
        }),
        context.now(),
      );
      continue;
    }
    const target = await recipient(db, orca, log, item, decision, context);
    if ("message" in target) {
      steps.push(
        `Decision ${decision.id} round ${item.round}: ${target.message}; run pod check again`,
      );
      continue;
    }
    log.at({
      run_id: decision.run_id,
      task_id: decision.task_id,
      op_key: opKey,
    });
    const sent = await orca.send({
      to: `dispatch:${target.to}`,
      subject: `decision ${decision.id} round ${item.round}${suffix[item.kind]}`,
      body: target.body,
    });
    if (sent.exitCode !== 0) {
      steps.push(
        `send of Decision ${decision.id} round ${item.round} to Dispatch ${target.to} failed; Dispatch ${target.to} stays waiting`,
      );
      continue;
    }
    await db.setDispatchActivity(target.to, "running");
    await db.moveOperation(
      opKey,
      "done",
      Json.parse({ send: sent.result ?? null, to: target.to }),
      context.now(),
    );
  }
  return steps;
}

type Target = { to: string; body: string } | { message: string };

async function recipient(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  item: FollowUp,
  decision: DecisionRow,
  context: FollowContext,
): Promise<Target> {
  const fields = await fieldsOf(db, decision, item.round);
  const { templates } = context;
  switch (item.kind) {
    case "round_next":
      return {
        to: (await openDecider(db, decision)) ?? item.to,
        body: renderTemplate(templates?.round_next ?? "{{audit}}", {
          ...fields,
          audit: item.audit,
          points_of_disagreement: item.points_of_disagreement
            .map((point) => `- ${point}`)
            .join("\n"),
        }),
      };
    case "evidence_request":
      return {
        to: (await openDecider(db, decision)) ?? item.to,
        body: renderTemplate(templateOf(templates, "evidence_request"), {
          ...fields,
          audit: item.audit,
        }),
      };
    case "proposal":
      return seated(db, orca, log, decision, context, "auditor", 0, () =>
        proposalBody(decision, item),
      );
    case "round_evidence":
      return seated(db, orca, log, decision, context, "auditor", 0, () =>
        renderTemplate(templateOf(templates, "evidence"), {
          ...fields,
          proposal: item.proposal,
          citations: citationText(item.citations),
        }),
      );
    case "resume":
      return resumeTarget(db, orca, log, item, decision, context, fields);
  }
}

async function resumeTarget(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  item: FollowUp & { kind: "resume" },
  decision: DecisionRow,
  context: FollowContext,
  fields: Fields,
): Promise<Target> {
  const summary = renderTemplate(
    templateOf(context.templates, "resume_summary"),
    { ...fields, summary: await summaryOf(db, decision.id) },
  );
  const proposed = await proposalOf(db, decision.id, item.round);
  if (proposed !== null)
    return seated(
      db,
      orca,
      log,
      decision,
      context,
      "auditor",
      item.relaunch,
      () =>
        [
          summary,
          proposalBody(decision, {
            round: item.round,
            proposal: proposed.proposal.proposal,
            citations: proposed.proposal.citations,
          }),
        ].join("\n\n"),
    );
  return seated(
    db,
    orca,
    log,
    decision,
    context,
    "decider",
    item.relaunch,
    () =>
      [
        summary,
        renderTemplate(context.templates?.round_open ?? "{{question}}", fields),
      ].join("\n\n"),
  );
}

async function openDecider(
  db: Db,
  decision: DecisionRow,
): Promise<string | null> {
  const open = (await db.listDispatches(decision.run_id)).find(
    (row) =>
      row.decision_id === decision.id &&
      row.role === "decider" &&
      row.settlement === "open",
  );
  return open?.dispatch_id ?? null;
}

async function seated(
  db: Db,
  orca: OrcaPort,
  log: ReceiptLog,
  decision: DecisionRow,
  context: FollowContext,
  role: SeatRole,
  relaunch: number,
  body: () => string,
): Promise<Target> {
  if (context.templates === null)
    return { message: `no active decision Revision to render the ${role}` };
  const fields = await fieldsOf(db, decision, 0);
  const seat = await openDecisionSeat(db, orca, log, {
    run: context.run,
    decisionId: decision.id,
    role,
    spec: renderTemplate(context.templates[role], fields),
    manifestId: decision.manifest_id,
    generation: context.generation,
    host: context.host,
    capacity: context.capacity,
    now: context.now,
    relaunch,
  });
  if (seat.ok) return { to: seat.dispatch.dispatch_id, body: body() };
  if (seat.runtimeFailure === true) {
    await db.transaction((tx) =>
      failDecision(tx, {
        decision: decision.id,
        at: context.now(),
        host: context.host,
      }),
    );
    return {
      message: `${seat.refusal.code} ${seat.refusal.message}; Decision ${decision.id} is needs_human: runtime-failure`,
    };
  }
  return { message: `${seat.refusal.code} ${seat.refusal.message}` };
}

type Fields = Record<
  "decision_id" | "question" | "options" | "manifest_id" | "manifest" | "round",
  string
>;

async function fieldsOf(
  db: Db,
  decision: DecisionRow,
  round: number,
): Promise<Fields> {
  const manifest = await db.getManifest(decision.manifest_id);
  const parsed = z.array(ManifestReference).safeParse(manifest?.references);
  return {
    decision_id: decision.id,
    question: decision.question,
    options: optionsText(z.array(z.string()).parse(decision.options)),
    manifest_id: decision.manifest_id,
    manifest: parsed.success ? manifestText(parsed.data) : "",
    round: String(round),
  };
}

function citationText(citations: readonly string[]): string {
  return citations.length === 0 ? "none" : citations.join(", ");
}

function proposalBody(
  decision: DecisionRow,
  item: { round: number; proposal: string; citations: readonly string[] },
): string {
  return [
    `Decision ${decision.id} round ${item.round}. Audit this proposal.`,
    "",
    `Question: ${decision.question}`,
    `Proposal: ${item.proposal}`,
    `Citations: ${citationText(item.citations)}`,
  ].join("\n");
}

const RoundAudit = z.looseObject({ reasons: z.array(z.string()) });

export async function summaryOf(db: Db, decisionId: string): Promise<string> {
  const rows = await db.listDecisionRounds(decisionId);
  if (rows.length === 0) return "none";
  return rows
    .map((row) => {
      const proposal = z
        .looseObject({ proposal: z.string() })
        .safeParse(row.proposal);
      const audit = RoundAudit.safeParse(row.audit);
      return `round ${row.round}: ${row.stance}; proposal: ${proposal.data?.proposal ?? ""}; audit: ${(audit.data?.reasons ?? []).join("; ")}`;
    })
    .join("\n");
}
