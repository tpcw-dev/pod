import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { runCreate } from "../../src/core/run/create.ts";
import type { TrackerPort } from "../../src/core/ports/tracker.ts";
import { ok } from "../orca/temp-fixtures.ts";
import { clearDb } from "./helpers.ts";
import {
  batch,
  dispatched,
  empty,
  message,
  replay,
  workers,
} from "./run-fixture.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];

export const gateProcess = (
  gate: string,
  shipGate?: string,
  review: "worker" | "human_wait" = "worker",
) => ({
  ...processValue,
  steps: [
    ...processValue.steps.map((step) => {
      if (step.id !== "review") return step;
      if (review === "worker") return { ...step, gate };
      return {
        id: step.id,
        type: "human_wait" as const,
        needs: step.needs ?? [],
        gate,
      };
    }),
    {
      id: "ship",
      type: "worker",
      role: "developer",
      needs: ["review"],
      spec: "Ship it.",
      ...(shipGate === undefined ? {} : { gate: shipGate }),
    },
  ],
  edges: [
    { from: "build", on: "done", to: "review" },
    { from: "build", on: hold, to: "hold" },
    { from: "review", on: "PASS", to: "ship" },
    { from: "review", on: "FAIL", to: "hold" },
    { from: "review", on: hold, to: "hold" },
    { from: "ship", on: "done", to: "done" },
    { from: "ship", on: hold, to: "hold" },
  ],
});

export const headSha = "0123456789abcdef0123456789abcdef01234567";

export const checkArgs = {
  run: "run_1",
  generation: 1,
  host: "local",
  capacity: 2,
  leaseSeconds: launchLeaseSeconds,
  now: () => new Date(),
};

export async function deliver(
  conn: Connection,
  dispatchId: string,
  taskId: string,
  fields: Record<string, unknown> = {},
  tracker: TrackerPort | null = null,
) {
  const run = ["--run", "run_1"];
  const { orca, log } = replay(conn, [
    ok(
      "check",
      batch(`delivery_${dispatchId}`, [
        message(`msg_${dispatchId}`, "worker_done", {
          taskId,
          dispatchId,
          outcome: "succeeded",
          ...fields,
        }),
      ]),
      run,
    ),
    ok("check", empty(`delivery_${dispatchId}`), [
      ...run,
      "--ack",
      `delivery_${dispatchId}`,
    ]),
    ok(
      "worker-list",
      workers([{ dispatchId, taskId, workerState: "succeeded" }]),
      run,
    ),
  ]);
  const checked = await checkPass(conn.db, orca, tracker, log, checkArgs);
  orca.assertDone();
  if (!checked.ok) throw new Error(checked.refusal.message);
  return checked;
}

export interface GatedRun {
  gates: Json;
  principals?: Json;
  builder?: string;
  gate?: string;
  shipGate?: string;
  review?: "worker" | "human_wait";
  reviewFields?: Record<string, unknown>;
}

export async function gatedRun(
  conn: Connection,
  {
    gates,
    principals,
    builder = "dev-1",
    gate = "pr",
    shipGate,
    review = "worker",
    reviewFields = {},
  }: GatedRun,
): Promise<void> {
  await clearDb(conn);
  await activeRevision(conn.db, "policy", "default", {
    gates,
    ...(principals === undefined ? {} : { principals }),
  });
  await activeRevision(conn.db, "crew", "default", crewValue);
  await activeRevision(
    conn.db,
    "process",
    "impl",
    gateProcess(gate, shipGate, review),
  );
  const { orca, log } = replay(conn, [
    ok("run-create", { run: { id: "run_1" } }),
    ok("task-create", { task: { id: "task_b", status: "ready" } }),
    ok("task-create", { task: { id: "task_r", status: "pending" } }),
    ok("task-create", { task: { id: "task_s", status: "pending" } }),
  ]);
  const created = await runCreate(conn.db, orca, null, log, {
    story: "S-1",
    process: { name: "impl", rev: 1 },
    size: "s",
    stage: "impl",
    coordinator: "session-1",
    host: "local",
    provider: "linear",
    command: "pod run create story:S-1",
    now: () => new Date(),
  });
  if (!created.ok) throw new Error(created.refusal.message);
  await dispatched(conn, "ctx_1", { seat: builder });
  await deliver(conn, "ctx_1", "task_b", { head: headSha });
  if (review === "human_wait") return;
  await dispatched(conn, "ctx_2", { task: "task_r", seat: "rev-1" });
  await deliver(conn, "ctx_2", "task_r", reviewFields);
}
