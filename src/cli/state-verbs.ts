import { writeFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { StateGatesView, StateView } from "../core/domain/state.ts";
import { serviceKinds } from "../core/config/service-kinds.ts";
import { receiptLog } from "../core/ledger/receipts.ts";
import { renderStateHtml } from "../core/manifest/html.ts";
import { renderState } from "../core/state/render.ts";
import { buildState, buildStateGates } from "../core/state/view.ts";
import { docsFor } from "./docs.ts";
import { PodError, exitFor, usageError } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";
import type { Refused } from "../core/domain/outcome.ts";

const storyArg = z.string().regex(/^story:.+$/);

export const StateInput = z.strictObject({
  args: z.union([z.tuple([]), z.tuple([storyArg])]),
  project: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  json: z.boolean().optional(),
  section: z.array(z.string()).optional(),
});
type StateInput = z.infer<typeof StateInput>;

export const StateOutput = z.union([StateView, StateGatesView]);
type StateOutput = z.infer<typeof StateOutput>;

function refused(built: Refused): PodError {
  return new PodError(
    built.refusal.code,
    exitFor(built.refusal.code),
    built.refusal.message,
    built.refusal.nextSteps,
  );
}

async function stateGates(
  input: StateInput,
  sections: readonly string[],
): Promise<StateGatesView> {
  const unknown = sections.find((name) => name !== "gates");
  if (unknown !== undefined)
    throw usageError(`usage: state --section ${unknown} is not a section`, [
      "pod state story:<id> --section gates",
    ]);
  const arg = input.args[0];
  if (arg === undefined)
    throw usageError("usage: state --section gates needs story:<id>", [
      "pod state story:<id> --section gates",
    ]);
  if (input.html !== undefined)
    throw usageError(
      "usage: state --section takes no --html; the HTML page renders the whole state",
      ["pod state story:<id> --html FILE"],
    );
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const built = await buildStateGates(
      {
        repo: connection.db,
        host: host.hostId,
        docs: null,
        now: () => new Date(),
      },
      { story: arg.slice("story:".length), project: input.project ?? null },
    );
    if (!built.ok) throw refused(built);
    return StateGatesView.parse(built.view);
  } finally {
    await connection.close();
  }
}

export async function stateVerb(input: StateInput): Promise<StateOutput> {
  if (input.section !== undefined) return stateGates(input, input.section);
  const arg = input.args[0];
  const host = readHostProfile();
  const connection = connect(databaseUrl(host));
  try {
    const log = receiptLog(connection.db, host.hostId);
    const { docsKind } = await serviceKinds(connection.db);
    const wiring = await docsFor(log.docsSink, host, docsKind);
    const built = await buildState(
      {
        repo: connection.db,
        host: host.hostId,
        docs: wiring?.port ?? null,
        now: () => new Date(),
      },
      {
        story: arg === undefined ? null : arg.slice("story:".length),
        project: input.project ?? null,
      },
    );
    if (!built.ok) throw refused(built);
    const view = StateView.parse(built.view);
    if (input.html !== undefined)
      writeFileSync(
        input.html,
        renderStateHtml(renderState(view), JSON.stringify(view)),
      );
    return view;
  } finally {
    await connection.close();
  }
}
