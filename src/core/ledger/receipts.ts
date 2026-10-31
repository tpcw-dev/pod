import { Json } from "../domain/json.ts";
import type { Repo } from "../ports/db.ts";
import type { ReceiptRecord, ReceiptSink } from "../ports/orca.ts";
import type {
  TrackerReceiptRecord,
  TrackerReceiptSink,
} from "../ports/tracker.ts";

export interface ReceiptContext {
  run_id: string | null;
  task_id: string | null;
  op_key: string | null;
}

export interface ReceiptLog {
  sink: ReceiptSink;
  trackerSink: TrackerReceiptSink;
  at(context: ReceiptContext): void;
}

export function receiptLog(
  db: Pick<Repo, "appendEvent">,
  host: string,
): ReceiptLog {
  let context: ReceiptContext = { run_id: null, task_id: null, op_key: null };
  const append = (record: ReceiptRecord | TrackerReceiptRecord) =>
    db.appendEvent({
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
  return {
    at(next) {
      context = next;
    },
    async sink(record) {
      await append(record);
    },
    async trackerSink(record) {
      await append(record);
    },
  };
}
