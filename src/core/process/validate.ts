import { refuse, type Refused } from "../domain/outcome.ts";
import {
  allowedOutcomes,
  edgeOutcomes,
  issuePath,
  ProcessValue,
  type Step,
} from "./schema.ts";

type Checked = { ok: true; value: ProcessValue } | Refused;

const reserved = new Set(["hold", "done"]);

function invalid(message: string, rule: string): Refused {
  return refuse("schema_invalid", message, [rule]);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function seatRoles(crew: unknown): string[][] {
  const seats = record(crew)["seats"];
  if (!Array.isArray(seats)) return [];
  return seats.map((seat) => {
    const roles = record(seat)["roles"];
    return Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === "string")
      : [];
  });
}

function gateIds(policy: unknown): Set<string> {
  const gates = record(policy)["gates"];
  if (Array.isArray(gates))
    return new Set(
      gates.flatMap((gate) => {
        if (typeof gate === "string") return [gate];
        const id = record(gate)["id"];
        return typeof id === "string" ? [id] : [];
      }),
    );
  return new Set(Object.keys(record(gates)));
}

function unreachable(value: ProcessValue): Refused | null {
  const [first] = value.steps;
  if (first === undefined) return null;
  const reached = new Set([first.id]);
  const queue = [first.id];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    const next = [
      ...value.edges
        .filter((edge) => edge.from === at)
        .flatMap((edge) => [
          edge.to,
          ...(edge.then === undefined ? [] : [edge.then]),
        ]),
      ...value.steps
        .filter((step) => step.needs.includes(at))
        .map((step) => step.id),
    ];
    for (const id of next)
      if (!reached.has(id)) {
        reached.add(id);
        queue.push(id);
      }
  }
  const i = value.steps.findIndex((step) => !reached.has(step.id));
  const step = value.steps[i];
  return step === undefined
    ? null
    : invalid(
        `steps.${i}: step ${step.id} is not reachable from ${first.id}`,
        "every step is reachable from the first step through needs and edges",
      );
}

function uncovered(value: ProcessValue): Refused | null {
  const rule = "every step has an edge for each outcome its type allows";
  const steps = new Map(value.steps.map((step) => [step.id, step]));
  for (const step of value.steps) {
    const covered = new Set(
      value.edges.filter((edge) => edge.from === step.id).flatMap(edgeOutcomes),
    );
    const missing = allowedOutcomes(step).find((on) => !covered.has(on));
    if (missing !== undefined)
      return invalid(`edges: step ${step.id} has no edge for ${missing}`, rule);
  }
  const seen = new Set<string>();
  for (const [k, edge] of value.edges.entries()) {
    const step = steps.get(edge.from);
    if (step === undefined) continue;
    const allowed = allowedOutcomes(step);
    for (const on of edgeOutcomes(edge)) {
      if (!allowed.includes(on))
        return invalid(
          `edges.${k}.on: step ${step.id} does not allow ${on}`,
          rule,
        );
      const key = `${step.id} ${on}`;
      if (seen.has(key))
        return invalid(
          `edges.${k}.on: step ${step.id} has a second edge for ${on}`,
          rule,
        );
      seen.add(key);
    }
  }
  return null;
}

function unknownTarget(value: ProcessValue): Refused | null {
  const rule = "an edge targets a step id, hold, or done";
  const ids = new Set(value.steps.map((step) => step.id));
  for (const [k, edge] of value.edges.entries()) {
    if (!ids.has(edge.from))
      return invalid(`edges.${k}.from: unknown step ${edge.from}`, rule);
    if (!ids.has(edge.to) && !reserved.has(edge.to))
      return invalid(`edges.${k}.to: unknown target ${edge.to}`, rule);
    if (edge.then !== undefined && !ids.has(edge.then))
      return invalid(`edges.${k}.then: unknown step ${edge.then}`, rule);
  }
  return null;
}

function failWithoutTask(value: ProcessValue): Refused | null {
  for (const [k, edge] of value.edges.entries())
    if (
      edgeOutcomes(edge).includes("FAIL") &&
      edge.to !== "hold" &&
      edge.new_task !== true
    )
      return invalid(
        `edges.${k}: a FAIL edge from ${edge.from} targets ${edge.to} without new_task`,
        "a FAIL edge targets hold or has new_task: true",
      );
  return null;
}

function badDecision(value: ProcessValue): Refused | null {
  const rule =
    "a step has gate or decision, never both; a decision step is a worker whose cancelled edge targets hold";
  for (const [i, step] of value.steps.entries()) {
    if (step.decision === undefined) continue;
    if (step.gate !== undefined)
      return invalid(
        `steps.${i}: step ${step.id} has both gate and decision`,
        rule,
      );
    if (step.type !== "worker")
      return invalid(
        `steps.${i}: step ${step.id} has decision but is ${step.type}`,
        rule,
      );
    for (const [k, edge] of value.edges.entries())
      if (
        edge.from === step.id &&
        edgeOutcomes(edge).includes("cancelled") &&
        edge.to !== "hold"
      )
        return invalid(
          `edges.${k}.to: the cancelled edge of decision step ${step.id} targets ${edge.to}, not hold`,
          rule,
        );
  }
  return null;
}

function unfilled(value: ProcessValue, seats: string[][]): Refused | null {
  const held = new Set(seats.flat());
  const wanted = [
    ...value.steps.flatMap((step) =>
      step.role === undefined ? [] : [step.role],
    ),
    ...value.roles,
  ];
  const role = wanted.find((name) => !held.has(name));
  return role === undefined
    ? null
    : refuse("role_unfilled", `no crew seat holds role ${role}`, [
        `add a seat with role ${role} to the active crew`,
      ]);
}

function independentOf(value: ProcessValue, step: Step): string[] {
  const steps = new Map(value.steps.map((other) => [other.id, other]));
  const roles = new Set<string>();
  const seen = new Set<string>();
  const queue = [...step.needs];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const other = steps.get(id);
    if (seen.has(id) || other?.role === undefined) continue;
    seen.add(id);
    if (other.role === step.role) queue.push(...other.needs);
    else roles.add(other.role);
  }
  return [...roles];
}

function notIndependent(
  value: ProcessValue,
  seats: string[][],
): Refused | null {
  for (const step of value.steps) {
    const { role } = step;
    if (step.type !== "worker" || step.gate === undefined || role === undefined)
      continue;
    const needed = independentOf(value, step);
    const free = seats.some(
      (seat) =>
        seat.includes(role) && !needed.some((other) => seat.includes(other)),
    );
    if (!free) {
      const names = needed.join(", ");
      return refuse(
        "reviewer_not_independent",
        `step ${step.id}: no seat with role ${role} is free of ${names}`,
        [`add a ${role} seat that holds none of ${names}`],
      );
    }
  }
  return null;
}

function unknownGate(value: ProcessValue, gates: Set<string>): Refused | null {
  for (const [i, step] of value.steps.entries())
    if (step.gate !== undefined && !gates.has(step.gate))
      return invalid(
        `steps.${i}.gate: gate ${step.gate} is not in the active policy`,
        `add gate ${step.gate} to the active policy`,
      );
  return null;
}

export function validateProcess(
  value: unknown,
  crew: unknown,
  policy: unknown,
): Checked {
  const parsed = ProcessValue.safeParse(value);
  if (!parsed.success) {
    const path = issuePath(parsed.error);
    return invalid(
      path,
      `fix ${path.split(":")[0] ?? "value"} to match the process schema`,
    );
  }
  const process = parsed.data;
  const seats = seatRoles(crew);
  const refusal =
    unreachable(process) ??
    uncovered(process) ??
    unknownTarget(process) ??
    failWithoutTask(process) ??
    badDecision(process) ??
    unfilled(process, seats) ??
    notIndependent(process, seats) ??
    unknownGate(process, gateIds(policy));
  return refusal ?? { ok: true, value: process };
}
