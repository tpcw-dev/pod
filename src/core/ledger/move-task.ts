import type { Task } from "../domain/ledger.ts";
import {
  canMove,
  TaskTransitionInvalid,
  type TaskState,
} from "../domain/task-state.ts";
import type { Repo } from "../ports/db.ts";

export async function moveTask(
  tx: Repo,
  taskId: string,
  to: TaskState,
): Promise<Task> {
  const task = await tx.getTask(taskId);
  if (task === null)
    throw new TaskTransitionInvalid(taskId, "missing", to, `no Task ${taskId}`);
  if (!canMove(task.state, to))
    throw new TaskTransitionInvalid(taskId, task.state, to);
  await tx.setTaskState(taskId, to);
  return task;
}
