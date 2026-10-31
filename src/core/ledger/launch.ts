import { z } from "zod";
import { Json } from "../domain/json.ts";
import { refuse, type Refusal } from "../domain/outcome.ts";
import type { Operation } from "../domain/ledger.ts";
import type { OrcaPort, Receipt } from "../ports/orca.ts";
import type { ReceiptContext, ReceiptLog } from "./receipts.ts";

export type LaunchOutcome =
  | { kind: "ok" }
  | { kind: "unknown"; requestId: string | null }
  | { kind: "failed" };

const unknownCodes = [
  "runtime_unavailable",
  "remote_runtime_unavailable",
  "runtime_timeout",
  "invalid_runtime_response",
];

const Envelope = z.looseObject({
  ok: z.boolean().optional(),
  result: z
    .looseObject({
      state: z.string().optional(),
      requestId: z.string().optional(),
    })
    .nullish(),
  error: z
    .looseObject({
      code: z.string().optional(),
      data: z
        .looseObject({
          orchestrationRequestId: z.string().optional(),
          recovery: z
            .looseObject({ disposition: z.string().optional() })
            .optional(),
        })
        .nullish(),
    })
    .nullish(),
});

export function failure(verb: string, raw: unknown, exitCode: number): Json {
  return { outcome: "failed", verb, exitCode, raw: Json.parse(raw ?? null) };
}

export function launchOutcome(receipt: Receipt<unknown>): LaunchOutcome {
  const envelope = Envelope.safeParse(receipt.raw);
  if (!envelope.success) return { kind: "unknown", requestId: null };
  const { result, error } = envelope.data;
  const requestId =
    error?.data?.orchestrationRequestId ?? result?.requestId ?? null;
  const unknown =
    (receipt.exitCode !== 0 && receipt.exitCode !== 1) ||
    result?.state === "outcome_unknown" ||
    error?.data?.recovery?.disposition === "outcome_unknown" ||
    unknownCodes.includes(error?.code ?? "");
  if (unknown) return { kind: "unknown", requestId };
  const state = result?.state;
  if (
    receipt.exitCode === 0 &&
    receipt.result !== null &&
    (state === undefined || state === "ready")
  )
    return { kind: "ok" };
  if (receipt.exitCode === 0) return { kind: "unknown", requestId };
  return { kind: "failed" };
}

const OpenRef = z.looseObject({ requestId: z.string().nullish() }).nullish();

export async function stopOnOpen(
  orca: OrcaPort,
  log: ReceiptLog,
  context: ReceiptContext,
  operation: Pick<Operation, "op_key" | "status" | "result_ref">,
  retry: string,
): Promise<{ ok: false; refusal: Refusal }> {
  const ref = OpenRef.safeParse(operation.result_ref);
  const requestId = ref.success ? (ref.data?.requestId ?? null) : null;
  let state = "no request id recorded";
  if (requestId !== null) {
    log.at(context);
    const shown = await orca.requestShow({ request: requestId });
    state = `request-show ${requestId}: ${shown.result?.state ?? "no answer"}`;
  }
  return refuse(
    "launch_unknown",
    `operation ${operation.op_key} is ${operation.status}; ${state}`,
    [retry, "pod check"],
  );
}
