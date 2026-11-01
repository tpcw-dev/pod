import { z } from "zod";
import type { Refusal } from "../domain/outcome.ts";
import {
  listedMembers,
  parseBudget,
  reservedClasses,
  reservedOf,
  type ReservedClass,
} from "../domain/policy.ts";
import { GateEntry } from "../gate/receipt.ts";

const Fields = z.record(z.string(), z.unknown());

function fields(value: unknown): Record<string, unknown> {
  return Fields.safeParse(value).data ?? {};
}

const snakeCase = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const liftable = ["prd_review", "design_clickthrough"];
const liftedTo = "decision-pair-aqa";

interface GateRow {
  id: string;
  path: string;
  entry: unknown;
}

function gateRows(gates: unknown): GateRow[] {
  if (Array.isArray(gates))
    return gates.flatMap((gate, i) => {
      if (typeof gate === "string") return [];
      const id = fields(gate)["id"];
      return typeof id === "string"
        ? [{ id, path: `gates.${i}`, entry: gate }]
        : [];
    });
  return Object.entries(fields(gates)).map(([id, entry]) => ({
    id,
    path: `gates.${id}`,
    entry,
  }));
}

function gateIds(gates: unknown): string[] {
  if (Array.isArray(gates))
    return gates.flatMap((gate) => {
      if (typeof gate === "string") return [gate];
      const id = fields(gate)["id"];
      return typeof id === "string" ? [id] : [];
    });
  return Object.keys(fields(gates));
}

function seatIds(crewValue: unknown): string[] {
  const seats = fields(crewValue)["seats"];
  if (!Array.isArray(seats)) return [];
  return seats.flatMap((seat) => {
    const id = fields(seat)["id"];
    return typeof id === "string" ? [id] : [];
  });
}

type Problem = { path: string; message: string } | null;

function gateProblem(gates: unknown, crewValue: unknown | null): Problem {
  const seats = crewValue === null ? [] : seatIds(crewValue);
  for (const row of gateRows(gates)) {
    const keeper = fields(row.entry)["keeper"];
    if (typeof keeper !== "string" || keeper === "")
      return {
        path: `${row.path}.keeper`,
        message: `${row.path}.keeper: Gate ${row.id} needs exactly one keeper, a non-empty string`,
      };
    const gate = GateEntry.safeParse(row.entry);
    if (gate.success && gate.data.type === "HQA" && seats.includes(keeper))
      return {
        path: `${row.path}.keeper`,
        message: `${row.path}.keeper: HQA Gate ${row.id} names keeper ${keeper}, a Seat id of the active crew`,
      };
  }
  return null;
}

function profileProblem(profiles: unknown, gates: unknown): Problem {
  const ids = gateIds(gates);
  for (const [name, profile] of Object.entries(fields(profiles))) {
    const replaces = fields(fields(profile)["replaces"]);
    for (const [gate, to] of Object.entries(replaces)) {
      const path = `profiles.${name}.replaces.${gate}`;
      if (!liftable.includes(gate))
        return {
          path,
          message: `${path}: a profile may replace only ${liftable.join(" and ")}`,
        };
      if (to !== liftedTo)
        return {
          path,
          message: `${path}: the replacement must be ${liftedTo}`,
        };
      if (!ids.includes(gate))
        return {
          path,
          message: `${path}: names Gate ${gate}, which is not in gates`,
        };
    }
  }
  return null;
}

function isMap(value: unknown): boolean {
  return Fields.safeParse(value).success && !Array.isArray(value);
}

function sectionProblem(reserved: unknown): Problem {
  if (reserved === undefined) return null;
  if (!isMap(reserved))
    return {
      path: "reserved",
      message:
        "reserved: must be a map of deny, needs_human, and needs_existing_authorization",
    };
  const listed = fields(reserved);
  for (const kind of reservedClasses) {
    const section = listed[kind];
    const path = `reserved.${kind}`;
    if (section === undefined) continue;
    if (!Array.isArray(section) && !isMap(section))
      return { path, message: `${path}: must be a list of members or a map` };
    const items = Array.isArray(section)
      ? section
      : Object.values(fields(section));
    const bad = items.findIndex(
      (item) => typeof item !== "string" && !isMap(item),
    );
    if (bad !== -1) {
      const key = Array.isArray(section)
        ? String(bad)
        : Object.keys(fields(section))[bad];
      return {
        path: `${path}.${key}`,
        message: `${path}.${key}: a member is a name or an object`,
      };
    }
  }
  return null;
}

function reservedProblem(reserved: unknown): Problem {
  const shape = sectionProblem(reserved);
  if (shape !== null) return shape;
  const listed = fields(reserved);
  for (const kind of reservedClasses)
    for (const item of listedMembers(listed[kind], `reserved.${kind}`)) {
      if (typeof item.name !== "string" || !snakeCase.test(item.name))
        return {
          path: item.path,
          message: `${item.path}: member name ${JSON.stringify(item.name)} is not a snake_case identifier`,
        };
      if (!z.array(z.string().min(1)).safeParse(item.match).success)
        return {
          path: `${item.path}.match`,
          message: `${item.path}.match: match terms are a list of non-empty strings`,
        };
    }
  return null;
}

function limitsProblem(limits: unknown): Problem {
  const given = fields(limits);
  const rounds = given["decision_rounds"];
  if (rounds !== undefined && !z.int().min(1).max(3).safeParse(rounds).success)
    return {
      path: "limits.decision_rounds",
      message: "limits.decision_rounds: must be an integer from 1 to 3",
    };
  const budget = parseBudget(given["decision_budget"]);
  if (!budget.ok)
    return {
      path: `limits.decision_budget.${budget.field}`,
      message: `limits.decision_budget.${budget.field}: ${budget.message}`,
    };
  return null;
}

function authorizationsProblem(value: unknown): Problem {
  const map = fields(value)["authorizations"];
  if (map === undefined) return null;
  if (!Fields.safeParse(map).success || Array.isArray(map))
    return {
      path: "authorizations",
      message: "authorizations: must be a map keyed by Story external id",
    };
  const allowed = reservedOf(value).needs_existing_authorization.map(
    (row) => row.name,
  );
  for (const [story, entry] of Object.entries(fields(map))) {
    const path = `authorizations.${story}`;
    const row = fields(entry);
    const extra = Object.keys(row).find(
      (key) => key !== "authorizes" && key !== "story_kind",
    );
    if (extra !== undefined || !Array.isArray(row["authorizes"]))
      return {
        path,
        message: `${path}: an entry is { authorizes: [names], story_kind? }`,
      };
    for (const [i, name] of row["authorizes"].entries())
      if (typeof name !== "string" || !allowed.includes(name))
        return {
          path: `${path}.authorizes.${i}`,
          message: `${path}.authorizes.${i}: ${JSON.stringify(name)} is not a needs_existing_authorization member (${allowed.join(", ")})`,
        };
    if ("story_kind" in row && row["story_kind"] !== "infrastructure")
      return {
        path: `${path}.story_kind`,
        message: `${path}.story_kind: only infrastructure is accepted`,
      };
  }
  return null;
}

function escalateProblem(value: unknown): Problem {
  const list = fields(value)["escalate_when"];
  if (list === undefined || z.array(z.string().min(1)).safeParse(list).success)
    return null;
  return {
    path: "escalate_when",
    message: "escalate_when: must be a list of names",
  };
}

export function validatePolicy(
  value: unknown,
  crewValue: unknown | null,
): Refusal | null {
  const policy = fields(value);
  const problem =
    gateProblem(policy["gates"], crewValue) ??
    profileProblem(policy["profiles"], policy["gates"]) ??
    reservedProblem(policy["reserved"]) ??
    escalateProblem(value) ??
    limitsProblem(policy["limits"]) ??
    authorizationsProblem(value);
  return problem === null
    ? null
    : {
        code: "schema_invalid",
        message: problem.message,
        nextSteps: [problem.path],
      };
}

export function requiredRevisions(value: unknown): string[] {
  return Object.values(fields(fields(value)["profiles"])).flatMap((profile) => {
    const id = fields(fields(profile)["requires"])["policy_revision"];
    return typeof id === "string" ? [id] : [];
  });
}

export function activeProfile(value: unknown): string | null {
  const name = fields(value)["active_profile"];
  return name === undefined || name === null ? null : String(name);
}

const kept: Record<"deny" | "needs_human", readonly ReservedClass[]> = {
  deny: ["deny"],
  needs_human: ["deny", "needs_human"],
};

export function droppedMember(
  projectValue: unknown,
  globalValue: unknown,
): Refusal | null {
  const project = reservedOf(projectValue);
  const global = reservedOf(globalValue);
  for (const kind of ["deny", "needs_human"] as const)
    for (const row of global[kind]) {
      const held = kept[kind].some((into) =>
        project[into].some((item) => item.name === row.name),
      );
      if (!held)
        return {
          code: "schema_invalid",
          message: `reserved.${kind}: the project policy drops the global ${kind} member ${row.name}`,
          nextSteps: [`reserved.${kind}`],
        };
    }
  return null;
}
