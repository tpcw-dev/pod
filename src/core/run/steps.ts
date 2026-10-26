import { z } from "zod";

const StepList = z.array(
  z.looseObject({
    id: z.string().min(1),
    role: z.string().min(1),
    deps: z.array(z.string().min(1)).optional(),
    spec: z.string().optional(),
  }),
);

export interface Step {
  id: string;
  role: string;
  deps: string[];
  spec: string | null;
}

export class StepsInvalid extends Error {
  constructor(readonly path: string) {
    super(`the process value fails the step schema at ${path}`);
  }
}

function zodPath(error: z.ZodError): string {
  const [first] = error.issues;
  if (first === undefined) return "steps: invalid";
  const path = ["steps", ...first.path.map(String)].join(".");
  const expected =
    "expected" in first ? `expected ${String(first.expected)}` : first.message;
  return `${path}: ${expected}`;
}

export function readSteps(value: unknown): Step[] {
  const raw =
    value !== null && typeof value === "object" && "steps" in value
      ? value.steps
      : undefined;
  const parsed = StepList.safeParse(raw);
  if (!parsed.success) throw new StepsInvalid(zodPath(parsed.error));
  if (parsed.data.length === 0)
    throw new StepsInvalid("steps: expected at least one step");
  const steps = parsed.data.map((step) => ({
    id: step.id,
    role: step.role,
    deps: [...new Set(step.deps ?? [])],
    spec: step.spec ?? null,
  }));
  const ids = new Set<string>();
  for (const [i, step] of steps.entries()) {
    if (ids.has(step.id))
      throw new StepsInvalid(`steps.${i}.id: duplicate ${step.id}`);
    ids.add(step.id);
  }
  for (const [i, step] of steps.entries())
    for (const [j, dep] of step.deps.entries())
      if (!ids.has(dep))
        throw new StepsInvalid(`steps.${i}.deps.${j}: unknown step ${dep}`);
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
    const next = at.deps.find((dep) => remaining.has(dep));
    at = next === undefined ? undefined : byId.get(next);
  }
  const loopStart = at === undefined ? 0 : seen.indexOf(at.id);
  const loop = seen.slice(loopStart);
  return `steps: cycle ${[...loop, loop[0]].join(" -> ")}`;
}

export function topoOrder(steps: readonly Step[]): Step[] {
  const waiting = new Map(steps.map((step) => [step.id, step.deps.length]));
  const queue = steps.filter((step) => step.deps.length === 0);
  const ordered: Step[] = [];
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    ordered.push(step);
    for (const other of steps) {
      if (!other.deps.includes(step.id)) continue;
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
