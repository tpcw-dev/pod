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
import { LearningKinds } from "./learning-kinds.ts";
import { UsageLimitsValue } from "./limits.ts";
import { isMethod, methodRule } from "../process/schema.ts";

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

const profileKeys = [
  "replaces",
  "requires",
  "deploy_production",
  "method",
  "agent_activates",
];
const deploySettings = ["needs_human", "agent"];
const agentKinds = ["crew", "decision"];
const personKinds = ["policy", "process"];

function agentActivatesProblem(
  name: string,
  profile: Record<string, unknown>,
): Problem {
  if (!("agent_activates" in profile)) return null;
  const path = `profiles.${name}.agent_activates`;
  const kinds = profile["agent_activates"];
  if (!Array.isArray(kinds))
    return { path, message: `${path}: must be a list of kinds` };
  for (const kind of kinds) {
    if (typeof kind === "string" && personKinds.includes(kind))
      return {
        path,
        message: `${path}: an agent never activates ${personKinds.join(" or ")}, and ${kind} is listed`,
      };
    if (typeof kind !== "string" || !agentKinds.includes(kind))
      return {
        path,
        message: `${path}: each kind must be ${agentKinds.join(" or ")}, got ${JSON.stringify(kind)}`,
      };
  }
  return null;
}

function requiresProblem(
  name: string,
  profile: Record<string, unknown>,
): Problem {
  if (!("requires" in profile)) return null;
  const path = `profiles.${name}.requires`;
  const requires = profile["requires"];
  if (
    requires === null ||
    typeof requires !== "object" ||
    Array.isArray(requires)
  )
    return { path, message: `${path}: must be { policy_revision: <id> }` };
  const extra = Object.keys(requires).find((key) => key !== "policy_revision");
  if (extra !== undefined)
    return {
      path: `${path}.${extra}`,
      message: `${path}.${extra}: requires names only policy_revision`,
    };
  const revision = fields(requires)["policy_revision"];
  if (typeof revision !== "string" || revision === "")
    return {
      path: `${path}.policy_revision`,
      message: `${path}.policy_revision: must be a non-empty Revision id`,
    };
  return null;
}

function methodProblem(
  name: string,
  profile: Record<string, unknown>,
): Problem {
  if (!("method" in profile)) return null;
  const path = `profiles.${name}.method`;
  const method = profile["method"];
  if (!isMap(method))
    return { path, message: `${path}: must be a map of step id to method` };
  for (const [step, value] of Object.entries(fields(method)))
    if (!isMethod(value))
      return {
        path: `${path}.${step}`,
        message: `${path}.${step}: ${methodRule}`,
      };
  return null;
}

function profileProblem(profiles: unknown, gates: unknown): Problem {
  const ids = gateIds(gates);
  for (const [name, profile] of Object.entries(fields(profiles))) {
    const extra = Object.keys(fields(profile)).find(
      (key) => !profileKeys.includes(key),
    );
    if (extra !== undefined)
      return {
        path: `profiles.${name}.${extra}`,
        message: `profiles.${name}.${extra}: a profile carries only ${profileKeys.join(", ")}`,
      };
    if ("deploy_production" in fields(profile)) {
      const setting = fields(profile)["deploy_production"];
      if (typeof setting !== "string" || !deploySettings.includes(setting))
        return {
          path: `profiles.${name}.deploy_production`,
          message: `profiles.${name}.deploy_production: must be ${deploySettings.join(" or ")}`,
        };
    }
    const requires = requiresProblem(name, fields(profile));
    if (requires !== null) return requires;
    const method = methodProblem(name, fields(profile));
    if (method !== null) return method;
    const agent = agentActivatesProblem(name, fields(profile));
    if (agent !== null) return agent;
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

function activeProfileProblem(value: unknown): Problem {
  const name = activeProfile(value);
  if (name === null || Object.hasOwn(fields(fields(value)["profiles"]), name))
    return null;
  return {
    path: "active_profile",
    message: `active_profile: ${name} is not a profile this policy defines`,
  };
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
  const digest = given["digest_per_day"];
  if (digest !== undefined && !z.int().min(1).max(10).safeParse(digest).success)
    return {
      path: "limits.digest_per_day",
      message: "limits.digest_per_day: must be an integer from 1 to 10",
    };
  const usage = given["usage"];
  if (usage !== undefined && !UsageLimitsValue.safeParse(usage).success)
    return {
      path: "limits.usage",
      message:
        "limits.usage: must be { floor_percent: a number from 0 to 100, stale_minutes: a positive integer }",
    };
  const budget = parseBudget(given["decision_budget"]);
  if (!budget.ok)
    return {
      path: `limits.decision_budget.${budget.field}`,
      message: `limits.decision_budget.${budget.field}: ${budget.message}`,
    };
  return null;
}

function learningProblem(value: unknown): Problem {
  const learning = fields(value)["learning"];
  if (learning === undefined) return null;
  if (!Fields.safeParse(learning).success || Array.isArray(learning))
    return { path: "learning", message: "learning: must be a map" };
  const kinds = fields(learning)["kinds"];
  if (kinds !== undefined && !LearningKinds.safeParse(kinds).success)
    return {
      path: "learning.kinds",
      message:
        "learning.kinds: must be a non-empty list of distinct lowercase names",
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

const StoryStatus = z.strictObject({
  done: z.string().min(1),
  human_wait: z.string().min(1),
});
export type StoryStatus = z.infer<typeof StoryStatus>;

function storyStatusProblem(value: unknown): Problem {
  const given = fields(value)["story_status"];
  if (given === undefined) return null;
  const parsed = StoryStatus.safeParse(given);
  if (parsed.success) return null;
  const at = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
  const path = at === "" ? "story_status" : `story_status.${at}`;
  return {
    path,
    message: `${path}: story_status is { done: <status>, human_wait: <status> }, each a non-empty tracker status name`,
  };
}

export function storyStatusOf(value: unknown): StoryStatus | null {
  return StoryStatus.safeParse(fields(value)["story_status"]).data ?? null;
}

const Kind = z.string().min(1).optional();
const Services = z.object({
  tracker: z.strictObject({ kind: Kind, estimate_scale: Kind }).optional(),
  docs: z.strictObject({ kind: Kind }).optional(),
});
export type Services = z.infer<typeof Services>;

function servicesProblem(value: unknown): Problem {
  const parsed = Services.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const path = [
    ...(issue?.path ?? []),
    ...(issue?.code === "unrecognized_keys" ? issue.keys : []),
  ].join(".");
  return {
    path,
    message: `${path}: tracker is { kind, estimate_scale } and docs is { kind }, each a non-empty name`,
  };
}

export function servicesOf(value: unknown): Services {
  return Services.safeParse(value).data ?? {};
}

export function validatePolicy(
  value: unknown,
  crewValue: unknown | null,
): Refusal | null {
  const policy = fields(value);
  const problem =
    gateProblem(policy["gates"], crewValue) ??
    profileProblem(policy["profiles"], policy["gates"]) ??
    activeProfileProblem(value) ??
    reservedProblem(policy["reserved"]) ??
    escalateProblem(value) ??
    limitsProblem(policy["limits"]) ??
    storyStatusProblem(value) ??
    servicesProblem(value) ??
    learningProblem(value) ??
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
