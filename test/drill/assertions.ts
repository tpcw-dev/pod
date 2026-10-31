import { expect } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";

const gateOfStep: Record<string, string> = {
  review: "review",
  merge: "merge",
  hqa: "hqa_after_deploy",
};

export async function assertInvariants(conn: Connection): Promise<void> {
  expect(
    await conn.sql<{ dispatch_id: string }[]>`
      select d.dispatch_id
      from ledger.dispatch d
      join ledger.event e on e.op_key = d.op_key and e.type = 'receipt'
      where e.payload->>'verb' = 'worker-start'
        and e.payload->>'exitCode' = '0'
      group by d.dispatch_id
      having count(*) > 1`,
    "duplicate launch",
  ).toEqual([]);
  expect(
    await conn.sql<{ dispatch_id: string }[]>`
      select dispatch_id
      from ledger.event
      where type = 'start' and dispatch_id is not null
      group by task_id, dispatch_id
      having count(*) > 1`,
    "duplicate start",
  ).toEqual([]);

  const tasks = await conn.sql<
    { task_id: string; step_id: string; state: string }[]
  >`select task_id, step_id, state from ledger.task`;
  const receipts = await conn.sql<
    { task_id: string; gate_id: string; outcome: string }[]
  >`select task_id, gate_id, outcome from ledger.gate_receipt`;
  const passed = new Set(
    receipts
      .filter((row) => row.outcome === "PASS")
      .map((row) => `${row.task_id}:${row.gate_id}`),
  );
  for (const task of tasks) {
    const gate = gateOfStep[task.step_id];
    if (task.state !== "done" || gate === undefined) continue;
    expect(
      passed.has(`${task.task_id}:${gate}`),
      `done ${task.step_id} lacks PASS`,
    ).toBe(true);
  }
  const reviewPassed = receipts.some(
    (row) => row.gate_id === "review" && row.outcome === "PASS",
  );
  for (const task of tasks) {
    if (task.step_id === "pr" && task.state === "ready")
      expect(reviewPassed, "pr ready before review PASS").toBe(true);
  }

  expect(
    await conn.sql<{ state: string }[]>`select state from ledger.run`,
  ).not.toEqual(expect.arrayContaining([{ state: "done" }]));
  const stories = await conn.sql<{ status: string | null }[]>`
    select status from ledger.story`;
  expect(stories.some((row) => row.status === "Done"), "story Done").toBe(
    false,
  );
  const writes = await conn.sql<{ status: string | null }[]>`
    select payload->>'status' as status
    from ledger.outbox
    where payload->>'kind' = 'status'`;
  expect(writes.some((row) => row.status === "Done"), "status Done").toBe(
    false,
  );
}
