import { z } from "zod";
import { intents, type RunState } from "../domain/ledger.ts";
import { drainInForce } from "../ledger/drain-in-force.ts";
import type { Repo } from "../ports/db.ts";
import { ManifestReference } from "./references.ts";

export interface RestoreView {
  run_id: string;
  owner_generation: number;
  coordinator: string;
  run_state: RunState;
  drain_in_force: boolean;
  manifest_id: string;
  tasks: { task_id: string; step_id: string; role: string; state: string }[];
  dispatches: {
    dispatch_id: string;
    seat: string;
    task_id: string | null;
    decision_id: string | null;
    worktree: string | null;
    terminal_handle: string | null;
  }[];
  operations: { op_key: string; intent: string; status: string }[];
  nextSteps: string[];
}

const TaskExcerpt = z.looseObject({ task_id: z.string() });
const Placement = z.looseObject({ worktree: z.string().optional() }).catch({});
const OperationRef = z
  .looseObject({
    request: z
      .looseObject({
        run_id: z.string().optional(),
        task_id: z.string().optional(),
      })
      .optional(),
  })
  .catch({});

export async function restoreView(
  repo: Repo,
  runId: string,
  manifestId: string,
  nextSteps: readonly string[],
): Promise<RestoreView> {
  const run = await repo.getRun(runId);
  const manifest = await repo.getManifest(manifestId);
  if (run === null || manifest === null)
    throw new Error(`Run ${runId} or manifest ${manifestId} vanished`);
  const taskIds = z
    .array(ManifestReference)
    .parse(manifest.references)
    .filter((row) => row.source === "task")
    .map((row) => TaskExcerpt.parse(JSON.parse(row.excerpt)).task_id);
  const tasks: RestoreView["tasks"] = [];
  for (const id of taskIds) {
    const task = await repo.getTask(id);
    if (task === null) throw new Error(`Task ${id} vanished`);
    tasks.push({
      task_id: task.task_id,
      step_id: task.step_id,
      role: task.role,
      state: task.state,
    });
  }
  const dispatches = (await repo.listDispatches(runId))
    .filter((row) => row.settlement === "open")
    .map((row) => ({
      dispatch_id: row.dispatch_id,
      seat: row.seat,
      task_id: row.task_id,
      decision_id: row.decision_id,
      worktree: Placement.parse(row.requested_launch).worktree ?? null,
      terminal_handle: row.terminal_handle,
    }));
  const owned = new Set(taskIds);
  const operations = (
    await repo.listOperations(intents, ["pending", "unknown"])
  )
    .filter((row) => {
      const request = OperationRef.parse(row.result_ref).request;
      return (
        request?.run_id === runId ||
        (request?.task_id !== undefined && owned.has(request.task_id))
      );
    })
    .map((row) => ({
      op_key: row.op_key,
      intent: row.intent,
      status: row.status,
    }));
  return {
    run_id: run.run_id,
    owner_generation: run.owner_generation,
    coordinator: run.coordinator,
    run_state: run.state,
    drain_in_force: await drainInForce(repo, runId),
    manifest_id: manifestId,
    tasks,
    dispatches,
    operations,
    nextSteps: [...nextSteps],
  };
}

function section(title: string, lines: readonly string[]): string {
  return [title, ...(lines.length === 0 ? ["- none"] : lines)].join("\n");
}

export function renderRestoreView(view: RestoreView): string {
  return [
    section("Run", [
      `- run ${view.run_id}`,
      `- owner generation ${view.owner_generation}`,
      `- coordinator ${view.coordinator}`,
      `- state ${view.run_state}`,
      `- drain ${view.drain_in_force ? "in force" : "not in force"}`,
      `- manifest ${view.manifest_id}`,
    ]),
    section(
      "Tasks",
      view.tasks.map(
        (row) => `- ${row.task_id} ${row.step_id} ${row.role} ${row.state}`,
      ),
    ),
    section(
      "Open Dispatches",
      view.dispatches.map(
        (row) =>
          `- ${row.dispatch_id} seat ${row.seat} ${row.task_id === null ? `decision ${row.decision_id ?? "unknown"}` : `task ${row.task_id}`} worktree ${row.worktree ?? "unknown"} terminal ${row.terminal_handle ?? "unknown"}`,
      ),
    ),
    section(
      "Open operations",
      view.operations.map(
        (row) => `- ${row.op_key} ${row.intent} ${row.status}`,
      ),
    ),
    section(
      "Next steps",
      view.nextSteps.map((line) => `- ${line}`),
    ),
    "",
  ].join("\n\n");
}
