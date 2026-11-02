import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Activity } from "../../src/core/domain/ledger.ts";

export async function residentSeat(
  conn: Connection,
  dispatchId: string,
  role: "decider" | "auditor",
  activity: Activity = "running",
  over: { seat?: string; settlement?: string } = {},
): Promise<void> {
  const settlement = over.settlement ?? "open";
  await conn.db.insertOperation({
    op_key: `seat-${dispatchId}`,
    intent: "decide_seat",
    owner_generation: 1,
    at: new Date(),
  });
  await conn.db.moveOperation(`seat-${dispatchId}`, "done", null, new Date());
  await conn.db.insertDispatch({
    dispatch_id: dispatchId,
    task_id: null,
    decision_id: null,
    run_id: "run_1",
    seat: over.seat ?? (role === "decider" ? "dec-1" : "aud-1"),
    role,
    requested_launch: {},
    effective_launch: null,
    model_attribution: "unknown",
    retry_of: null,
    op_key: `seat-${dispatchId}`,
    settlement,
    terminal_handle: `term_${dispatchId}`,
    created_at: new Date(),
    settled_at: settlement === "open" ? null : new Date(),
    activity: settlement === "open" ? activity : "settled",
    manifest_id: null,
  });
}
