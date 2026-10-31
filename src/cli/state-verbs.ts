import { writeFileSync } from "node:fs";
import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { StateView } from "../core/domain/state.ts";
import { receiptLog, type ReceiptLog } from "../core/ledger/receipts.ts";
import { renderStateHtml } from "../core/manifest/html.ts";
import { renderState } from "../core/state/render.ts";
import { buildState } from "../core/state/view.ts";
import { docsFor } from "./docs.ts";
import { PodError, exitFor } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";

const storyArg = z.string().regex(/^story:.+$/);

export const StateInput = z.strictObject({
  args: z.union([z.tuple([]), z.tuple([storyArg])]),
  project: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  json: z.boolean().optional(),
});
type StateInput = z.infer<typeof StateInput>;

export const StateOutput = StateView;

export async function stateVerb(input: StateInput): Promise<StateView> {
  const arg = input.args[0];
  const host = readHostProfile();
  let log: ReceiptLog | null = null;
  const wiring = await docsFor((record) => {
    if (log === null) throw new Error("docs receipt before the ledger opened");
    return log.docsSink(record);
  }, host);
  const connection = connect(databaseUrl(host));
  try {
    log = receiptLog(connection.db, host.hostId);
    const built = await buildState(
      {
        repo: connection.db,
        docs: wiring?.port ?? null,
        now: () => new Date(),
      },
      {
        story: arg === undefined ? null : arg.slice("story:".length),
        project: input.project ?? null,
      },
    );
    if (!built.ok)
      throw new PodError(
        built.refusal.code,
        exitFor(built.refusal.code),
        built.refusal.message,
        built.refusal.nextSteps,
      );
    const view = StateOutput.parse(built.view);
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
