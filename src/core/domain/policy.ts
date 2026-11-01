import { z } from "zod";

export type ReservedClass =
  "deny" | "needs_human" | "needs_existing_authorization";

export const reservedClasses: readonly ReservedClass[] = [
  "deny",
  "needs_human",
  "needs_existing_authorization",
];

export interface ReservedMember {
  name: string;
  match: string[];
  requires: string | null;
}

export type Reserved = Record<ReservedClass, ReservedMember[]>;

export interface Budget {
  wall_clock: number;
  relaunches: number;
  tool_calls: number;
  context_tokens: number;
}

export type BudgetField = keyof Budget;

export const budgetFields: readonly BudgetField[] = [
  "wall_clock",
  "relaunches",
  "tool_calls",
  "context_tokens",
];

export const defaultBudgetText = {
  wall_clock: "2h",
  relaunches: 2,
  tool_calls: 40,
  context_tokens: "60k",
};

function member(
  name: string,
  match: string[],
  requires: string | null = null,
): ReservedMember {
  return { name, match, requires };
}

export const defaultReserved: Reserved = {
  deny: [
    member("live_trading", [
      "live trading",
      "live trade",
      "place an order",
      "real money",
    ]),
    member("evidence_tamper", [
      "tamper",
      "falsify",
      "forge evidence",
      "fake evidence",
      "edit the ledger",
      "rewrite the ledger",
    ]),
    member("safety_limit_removal", [
      "remove the limit",
      "disable the limit",
      "safety limit",
      "remove the guard",
      "disable the guard",
    ]),
  ],
  needs_human: [
    member("spend", [
      "pay",
      "purchase",
      "subscription",
      "budget",
      "cost",
      "spend",
      "buy",
      "$",
      "€",
      "£",
      "¥",
    ]),
    member("credentials", [
      "credential",
      "password",
      "secret",
      "api key",
      "access token",
      "private key",
      "ssh key",
    ]),
    member("data_delete", [
      "delete data",
      "data deletion",
      "drop table",
      "drop database",
      "truncate",
      "purge",
      "wipe",
    ]),
    member("deploy_production", [
      "production deploy",
      "deploy to production",
      "deploy production",
      "prod deploy",
      "deploy to prod",
    ]),
    member("gate_change_running_run", [
      "skip the gate",
      "lift the gate",
      "change the gate",
      "gate change",
      "bypass review",
    ]),
    member("policy_change", [
      "policy change",
      "change the policy",
      "edit the policy",
    ]),
    member("driver_or_gatekeeper_change", [
      "change the driver",
      "change the gatekeeper",
      "new gatekeeper",
      "reassign the ticket",
    ]),
  ],
  needs_existing_authorization: [
    member(
      "repo_create",
      ["create a repo", "new repo", "create a repository", "new repository"],
      "story_spec",
    ),
    member("vps_ssh", ["ssh", "vps"], "infrastructure_story"),
  ],
};

const Fields = z.record(z.string(), z.unknown());

function fields(value: unknown): Record<string, unknown> {
  return Fields.safeParse(value).data ?? {};
}

const Terms = z.array(z.string().min(1));

export interface ListedMember {
  path: string;
  name: unknown;
  match: unknown;
  requires: unknown;
}

export function listedMembers(section: unknown, path: string): ListedMember[] {
  if (Array.isArray(section))
    return section.map((item, i) => {
      if (typeof item === "string")
        return { path: `${path}.${i}`, name: item, match: [], requires: null };
      const row = fields(item);
      return {
        path: `${path}.${i}`,
        name: row["name"],
        match: row["match"] ?? [],
        requires: row["requires"] ?? null,
      };
    });
  return Object.entries(fields(section)).map(([name, item]) => {
    if (typeof item === "string")
      return { path: `${path}.${name}`, name, match: [], requires: item };
    const row = fields(item);
    return {
      path: `${path}.${name}`,
      name,
      match: row["match"] ?? [],
      requires: row["requires"] ?? null,
    };
  });
}

export function reservedOf(policyValue: unknown): Reserved {
  const listed = fields(fields(policyValue)["reserved"]);
  const merged = {} as Reserved;
  for (const kind of reservedClasses) {
    const rows = defaultReserved[kind].map((row) => ({
      ...row,
      match: [...row.match],
    }));
    for (const item of listedMembers(listed[kind], kind)) {
      if (typeof item.name !== "string" || item.name === "") continue;
      const match = Terms.safeParse(item.match).data ?? [];
      const requires = typeof item.requires === "string" ? item.requires : null;
      const found = rows.find((row) => row.name === item.name);
      if (found === undefined)
        rows.push(member(item.name, [...match], requires));
      else
        for (const term of match)
          if (!found.match.includes(term)) found.match.push(term);
    }
    merged[kind] = rows;
  }
  return merged;
}

export interface Authorization {
  authorizes: string[];
  story_kind: "infrastructure" | null;
}

const AuthorizationEntry = z.strictObject({
  authorizes: z.array(z.string()),
  story_kind: z.literal("infrastructure").optional(),
});

export function authorizationOf(
  policyValue: unknown,
  story: string,
): Authorization | null {
  const entry = AuthorizationEntry.safeParse(
    fields(fields(policyValue)["authorizations"])[story],
  );
  if (!entry.success) return null;
  return {
    authorizes: entry.data.authorizes,
    story_kind: entry.data.story_kind ?? null,
  };
}

const durationPattern = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const countPattern = /^(\d+)([km])?$/;

function count(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return null;
}

function duration(value: unknown): number | null {
  if (typeof value !== "string") return count(value);
  const found = durationPattern.exec(value);
  if (value === "" || found === null) return null;
  const [, h, m, s] = found;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

function tokens(value: unknown): number | null {
  if (typeof value !== "string") return count(value);
  const found = countPattern.exec(value);
  if (found === null) return null;
  const scale = found[2] === "k" ? 1_000 : found[2] === "m" ? 1_000_000 : 1;
  return Number(found[1]) * scale;
}

const readers: Record<BudgetField, (value: unknown) => number | null> = {
  wall_clock: duration,
  relaunches: count,
  tool_calls: count,
  context_tokens: tokens,
};

const formats: Record<BudgetField, string> = {
  wall_clock: "a duration such as 2h, 90m, or 1h30m",
  relaunches: "a non-negative integer",
  tool_calls: "a non-negative integer",
  context_tokens: "a count such as 60k",
};

export type ParsedBudget =
  | { ok: true; budget: Budget }
  | { ok: false; field: BudgetField; message: string };

export function parseBudget(value: unknown): ParsedBudget {
  const given = fields(value);
  const budget = {} as Budget;
  for (const field of budgetFields) {
    const raw = given[field] ?? defaultBudgetText[field];
    const read = readers[field](raw);
    if (read === null)
      return {
        ok: false,
        field,
        message: `${field} ${JSON.stringify(raw)} is not ${formats[field]}`,
      };
    budget[field] = read;
  }
  return { ok: true, budget };
}

export function budgetOf(value: unknown): Budget {
  const given = fields(value);
  const budget = {} as Budget;
  for (const field of budgetFields)
    budget[field] =
      readers[field](given[field]) ??
      (readers[field](defaultBudgetText[field]) as number);
  return budget;
}
