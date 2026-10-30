import { issuePath, ProcessValue, type StepType } from "../process/schema.ts";

export interface Step {
  id: string;
  type: StepType;
  role: string | null;
  needs: string[];
  spec: string | null;
}

export class StepsInvalid extends Error {
  constructor(readonly path: string) {
    super(`the process value fails the process schema at ${path}`);
  }
}

export function readSteps(value: unknown): Step[] {
  const parsed = ProcessValue.safeParse(value);
  if (!parsed.success) throw new StepsInvalid(issuePath(parsed.error));
  const steps = parsed.data.steps.map((step) => ({
    id: step.id,
    type: step.type,
    role: step.role ?? null,
    needs: [...new Set(step.needs)],
    spec: step.spec ?? null,
  }));
  topoOrder(steps);
  return steps;
}

function cyclePath(
  steps: readonly Step[],
  remaining: ReadonlySet<string>,
): string {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const start = steps.find((step) => remaining.has(step.id));
  const seen: string[] = [];
  let at = start;
  while (at !== undefined && !seen.includes(at.id)) {
    seen.push(at.id);
    const next = at.needs.find((need) => remaining.has(need));
    at = next === undefined ? undefined : byId.get(next);
  }
  const loopStart = at === undefined ? 0 : seen.indexOf(at.id);
  const loop = seen.slice(loopStart);
  return `steps: cycle ${[...loop, loop[0]].join(" -> ")}`;
}

export function topoOrder(steps: readonly Step[]): Step[] {
  const waiting = new Map(steps.map((step) => [step.id, step.needs.length]));
  const queue = steps.filter((step) => step.needs.length === 0);
  const ordered: Step[] = [];
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    ordered.push(step);
    for (const other of steps) {
      if (!other.needs.includes(step.id)) continue;
      const left = (waiting.get(other.id) ?? 0) - 1;
      waiting.set(other.id, left);
      if (left === 0) queue.push(other);
    }
  }
  if (ordered.length < steps.length) {
    const done = new Set(ordered.map((step) => step.id));
    const remaining = new Set(
      steps.filter((step) => !done.has(step.id)).map((step) => step.id),
    );
    throw new StepsInvalid(cyclePath(steps, remaining));
  }
  return ordered;
}
