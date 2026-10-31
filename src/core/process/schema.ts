import { z } from "zod";
import { Size } from "../domain/ledger.ts";

export { Size };

export const StepType = z.enum(["worker", "external_action", "human_wait"]);
export type StepType = z.infer<typeof StepType>;

export const Outcome = z.enum([
  "done",
  "timeout",
  "cancel",
  "unknown",
  "PASS",
  "FAIL",
  "agreed",
  "cancelled",
]);
export type Outcome = z.infer<typeof Outcome>;

const Name = z.string().min(1);

export const Step = z
  .strictObject({
    id: Name,
    type: StepType,
    role: Name.optional(),
    needs: z.array(Name).default([]),
    produces: z.array(Name).default([]),
    gate: Name.optional(),
    decision: Name.optional(),
    adapter: Name.optional(),
    event_fields: z.array(Name).default([]),
    binds: Name.optional(),
    spec: z.string().optional(),
  })
  .superRefine((step, ctx) => {
    if (step.type === "worker" && step.role === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "a worker step needs a role",
      });
    if (step.type !== "worker" && step.role !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: `a ${step.type} step takes no role`,
      });
  });
export type Step = z.infer<typeof Step>;

export const Edge = z.strictObject({
  from: Name,
  on: z.union([Outcome, z.array(Outcome).min(1)]),
  to: Name,
  new_task: z.boolean().optional(),
  then: Name.optional(),
});
export type Edge = z.infer<typeof Edge>;

export const Selector = z
  .strictObject({
    stage: Name,
    size: z.array(Size).min(1).optional(),
  })
  .superRefine((selector, ctx) => {
    if (selector.stage === "impl" && selector.size === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["size"],
        message: "an impl selector names at least one size",
      });
  });
export type Selector = z.infer<typeof Selector>;

export const ProcessValue = z
  .strictObject({
    summary: z.string(),
    selector: Selector,
    roles: z.array(Name),
    steps: z.array(Step).min(1),
    edges: z.array(Edge),
    limits: z.strictObject({
      attempts_per_task: z.int().positive(),
      rework_per_lineage: z.int().positive(),
    }),
    escalation: z.strictObject({ to: Name }),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [i, step] of value.steps.entries()) {
      if (ids.has(step.id))
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "id"],
          message: `duplicate ${step.id}`,
        });
      ids.add(step.id);
    }
    for (const [i, step] of value.steps.entries())
      for (const [j, need] of step.needs.entries())
        if (!ids.has(need))
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "needs", j],
            message: `unknown step ${need}`,
          });
  });
export type ProcessValue = z.infer<typeof ProcessValue>;

export function edgeOutcomes(edge: Edge): Outcome[] {
  return typeof edge.on === "string" ? [edge.on] : edge.on;
}

export function allowedOutcomes(step: Step): Outcome[] {
  switch (step.type) {
    case "human_wait":
      return ["PASS", "FAIL", "cancel"];
    case "external_action":
      return ["done", "unknown", "cancel"];
    case "worker": {
      const finished: Outcome[] =
        step.gate !== undefined
          ? ["PASS", "FAIL"]
          : step.decision !== undefined
            ? ["agreed", "cancelled"]
            : ["done"];
      return [...finished, "timeout", "cancel", "unknown"];
    }
  }
}

export function issuePath(error: z.ZodError): string {
  const [first] = error.issues;
  if (first === undefined) return "value: invalid";
  const path = first.path.map(String).join(".") || "value";
  const expected =
    "expected" in first ? `expected ${String(first.expected)}` : first.message;
  return `${path}: ${expected}`;
}
