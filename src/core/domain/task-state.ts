import { z } from "zod";

export const taskStates = [
  "pending",
  "ready",
  "dispatched",
  "delivered",
  "passed",
  "failed",
  "blocked",
  "hold",
  "done",
  "superseded",
] as const;
export const TaskState = z.enum(taskStates);
export type TaskState = z.infer<typeof TaskState>;

export interface Transition {
  from: TaskState;
  to: TaskState;
  trigger: string;
}

const toHold =
  "a timeout, cancel, or unknown outcome, a cancel event, or a lineage at its rework limit";
const changeSpec =
  "a change_spec Decision outcome applies a new Task spec Revision";
const resume = "pod check --resume per resumeTarget";

export const transitions: readonly Transition[] = [
  {
    from: "pending",
    to: "ready",
    trigger: "every Task in deps is satisfied",
  },
  {
    from: "ready",
    to: "dispatched",
    trigger: "pod dispatch records a start event for a worker step",
  },
  {
    from: "ready",
    to: "delivered",
    trigger: "an external_action event or a human_wait Gate receipt arrives",
  },
  {
    from: "dispatched",
    to: "delivered",
    trigger:
      "pod check records a delivery that matches the Dispatch and the owner generation",
  },
  {
    from: "dispatched",
    to: "blocked",
    trigger: "Orca reports the Task blocked after worker-stop",
  },
  {
    from: "blocked",
    to: "dispatched",
    trigger: "pod retry starts a new Dispatch with retry_of",
  },
  {
    from: "delivered",
    to: "passed",
    trigger:
      "a PASS Gate receipt, the accept_plan decision event, or the matching delivery for a step with neither",
  },
  {
    from: "delivered",
    to: "hold",
    trigger: "a cancelled Decision outcome on a step with a decision",
  },
  {
    from: "delivered",
    to: "failed",
    trigger: "a FAIL Gate receipt whose edge has new_task: true",
  },
  {
    from: "delivered",
    to: "hold",
    trigger: "a FAIL Gate receipt whose edge targets hold",
  },
  {
    from: "passed",
    to: "done",
    trigger: "the projector records the outgoing edge",
  },
  { from: "pending", to: "hold", trigger: toHold },
  { from: "ready", to: "hold", trigger: toHold },
  { from: "dispatched", to: "hold", trigger: toHold },
  { from: "delivered", to: "hold", trigger: toHold },
  { from: "passed", to: "hold", trigger: toHold },
  { from: "blocked", to: "hold", trigger: toHold },
  { from: "hold", to: "hold", trigger: toHold },
  {
    from: "hold",
    to: "ready",
    trigger: "the operator resumes after reconcile with pod check --resume",
  },
  { from: "pending", to: "superseded", trigger: changeSpec },
  { from: "ready", to: "superseded", trigger: changeSpec },
  { from: "hold", to: "superseded", trigger: changeSpec },
  { from: "dispatched", to: "superseded", trigger: changeSpec },
  { from: "delivered", to: "superseded", trigger: changeSpec },
  { from: "hold", to: "dispatched", trigger: resume },
  { from: "hold", to: "delivered", trigger: resume },
  { from: "hold", to: "blocked", trigger: resume },
  { from: "hold", to: "pending", trigger: resume },
];

export function canMove(from: TaskState, to: TaskState): boolean {
  return transitions.some((row) => row.from === from && row.to === to);
}

export class TaskTransitionInvalid extends Error {
  constructor(
    readonly taskId: string,
    readonly from: string,
    readonly to: string,
    detail?: string,
  ) {
    super(
      `Task ${taskId} cannot move from ${from} to ${to}${detail === undefined ? "" : `: ${detail}`}`,
    );
  }
}
