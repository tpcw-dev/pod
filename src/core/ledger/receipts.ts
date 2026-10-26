import { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";
import type { ReceiptRecord, ReceiptSink } from "../ports/orca.ts";

export interface ReceiptContext {
  run_id: string | null;
  task_id: string | null;
  op_key: string | null;
}

export interface ReceiptLog {
  sink: ReceiptSink;
  at(context: ReceiptContext): void;
}

export function receiptLog(db: Pick<Repo, "appendEvent">, host: string): ReceiptLog {
  let context: ReceiptContext = { run_id: null, task_id: null, op_key: null };
  return {
    at(next) {
      context = next;
    },
    async sink(record: ReceiptRecord) {
      await db.appendEvent({
        type: "receipt",
        ts: new Date(record.endedAt),
        host,
        run_id: context.run_id,
        task_id: context.task_id,
        dispatch_id: null,
        op_key: context.op_key,
        payload: Json.parse(record),
        source: { kind: "receipt", verb: record.verb },
      });
    },
  };
}
