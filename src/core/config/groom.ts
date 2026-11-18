import { z } from "zod";
import type { ActivationKey, RevisionEnvelope } from "../domain/config.ts";
import { Size } from "../domain/ledger.ts";
import type { Refusal } from "../domain/outcome.ts";

export const groomStages = ["impl", "prd", "design"] as const;

const Point = z.int().positive();
const Count = z.int().min(0);
const PointMap = <T extends z.ZodType>(item: T) => z.record(z.string(), item);
const Directory = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "needs a relative path inside the repository",
  );

const DefaultRow = z.strictObject({
  points: Point,
  max_paths: Count,
  max_callers: Count,
});

const GroomValue = z.strictObject({
  scale: z.array(Point).min(1),
  points_to_size: PointMap(Size),
  rubric: z.strictObject({
    impl: PointMap(z.string().min(1)),
    prd: PointMap(z.string().min(1)),
    design: PointMap(z.string().min(1)),
  }),
  tiers: PointMap(z.string().regex(/^[a-z][a-z0-9_-]*$/)),
  split_at: Point,
  child_max: Point,
  default_points: z.array(DefaultRow).min(1),
  proves: z.strictObject({ under: z.array(Directory).min(1) }),
});
export type GroomValue = z.infer<typeof GroomValue>;

export const activeGroom: ActivationKey = {
  scope: "global",
  scope_ref: "",
  kind: "groom",
  name: "default",
};

function invalid(message: string, path: string): Refusal {
  return { code: "schema_invalid", message, nextSteps: [path] };
}

function coverage(
  map: Record<string, unknown>,
  scale: readonly number[],
  path: string,
): Refusal | null {
  const points = scale.map(String);
  for (const point of points)
    if (!Object.hasOwn(map, point))
      return invalid(
        `${path} has no row for point ${point}`,
        `${path}.${point}`,
      );
  for (const key of Object.keys(map))
    if (!points.includes(key))
      return invalid(
        `${path} names ${key}, which is not on the scale`,
        `${path}.${key}`,
      );
  return null;
}

function scaleProblem(groom: GroomValue): Refusal | null {
  const { scale } = groom;
  for (let i = 1; i < scale.length; i += 1)
    if ((scale[i] ?? 0) <= (scale[i - 1] ?? 0))
      return invalid("scale must ascend strictly", `scale.${i}`);
  return (
    coverage(groom.points_to_size, scale, "points_to_size") ??
    groomStages
      .map((stage) => coverage(groom.rubric[stage], scale, `rubric.${stage}`))
      .find((refusal) => refusal !== null) ??
    coverage(groom.tiers, scale, "tiers")
  );
}

function splitProblem(groom: GroomValue): Refusal | null {
  const { scale, split_at, child_max } = groom;
  if (!scale.includes(split_at))
    return invalid(`split_at ${split_at} is not on the scale`, "split_at");
  if (!scale.includes(child_max) || child_max >= split_at)
    return invalid(
      `child_max ${child_max} must be a scale point below split_at ${split_at}`,
      "child_max",
    );
  return null;
}

function defaultsProblem(groom: GroomValue): Refusal | null {
  let previous: z.infer<typeof DefaultRow> | null = null;
  for (const [index, row] of groom.default_points.entries()) {
    const path = `default_points.${index}`;
    if (!groom.scale.includes(row.points) || row.points >= groom.split_at)
      return invalid(
        `${path}: points ${row.points} must be a scale point below split_at ${groom.split_at}`,
        `${path}.points`,
      );
    if (
      previous !== null &&
      (row.points <= previous.points ||
        row.max_paths < previous.max_paths ||
        row.max_callers < previous.max_callers)
    )
      return invalid(
        `${path}: rows ascend by points, and max_paths and max_callers never fall`,
        path,
      );
    previous = row;
  }
  const { under } = groom.proves;
  const repeated = under.findIndex((dir, i) => under.indexOf(dir) !== i);
  return repeated === -1
    ? null
    : invalid(
        `proves.under lists ${under[repeated]} twice`,
        `proves.under.${repeated}`,
      );
}

function checkGroom(
  value: unknown,
): { groom: GroomValue; refusal: null } | { groom: null; refusal: Refusal } {
  const parsed = GroomValue.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path =
      issue?.code === "unrecognized_keys"
        ? [...issue.path, ...issue.keys]
        : (issue?.path ?? []);
    return {
      groom: null,
      refusal: invalid(
        `groom value fails its schema: ${issue?.message ?? "invalid"}`,
        path.join("."),
      ),
    };
  }
  const groom = parsed.data;
  const refusal =
    scaleProblem(groom) ?? splitProblem(groom) ?? defaultsProblem(groom);
  return refusal === null ? { groom, refusal } : { groom: null, refusal };
}

export function validateGroom(value: unknown): Refusal | null {
  return checkGroom(value).refusal;
}

export function parseGroom(value: unknown): GroomValue {
  const { groom, refusal } = checkGroom(value);
  if (groom === null) throw new Error(refusal.message);
  return groom;
}

export function groomRefusal(envelope: RevisionEnvelope): Refusal | null {
  if (envelope.scope !== "global")
    return invalid(
      `a groom Revision has scope global, not ${envelope.scope}`,
      "scope",
    );
  if (envelope.name !== activeGroom.name)
    return invalid(
      `a groom Revision is named ${activeGroom.name}, not ${envelope.name}`,
      "name",
    );
  return validateGroom(envelope.value);
}
