import { singleActive } from "../core/config/active.ts";
import { principalsOf } from "../core/gate/receipt.ts";
import type { Repo } from "../core/ports/db.ts";
import { PodError } from "./errors.ts";
import type { HostSettings } from "./host-profile.ts";

export type Identity =
  { kind: "seat"; address: string } | { kind: "person"; principal: string };

export interface IdentityFacts {
  podSeat: string | null;
  recordedSeat: string | null;
  handle: string | null;
  unresolved: readonly string[];
  operator: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value === "" ? null : value;
}

export function seatFromEnv(env: Env): string | null {
  return envValue(env, "POD_SEAT");
}

const agentStep = "an agent Seat sets POD_SEAT to its Seat Address";

export interface PersonNeed {
  what: string;
  nextSteps: string[];
}

export const activation: PersonNeed = {
  what: "an activation",
  nextSteps: [
    "write the Revision without --activate",
    "a person runs the activation from the operator's shell",
  ],
};

function identityMissing(message: string, nextSteps: string[]): PodError {
  return new PodError("identity_missing", 3, message, nextSteps);
}

export function resolveIdentity(
  facts: IdentityFacts,
  need: PersonNeed | null,
): Identity {
  if (facts.podSeat !== null) return { kind: "seat", address: facts.podSeat };
  if (facts.recordedSeat !== null)
    return { kind: "seat", address: facts.recordedSeat };
  if (facts.unresolved.length > 0)
    throw identityMissing(
      "a worker Pod launched on this host has no recorded terminal yet, so this run cannot be told apart from it",
      [
        `unresolved: ${facts.unresolved.join(", ")}`,
        agentStep,
        "run again after pod check settles them",
      ],
    );
  if (facts.handle !== null) {
    const message = `terminal ${facts.handle} is neither a Seat this host records nor the operator's shell`;
    if (need !== null)
      throw new PodError(
        "activation_needs_person",
        3,
        `${message}, and ${need.what} needs a person`,
        need.nextSteps,
      );
    throw identityMissing(message, [
      "set POD_SEAT to your Seat Address and run again",
      "the operator runs pod from a shell with no ORCA_TERMINAL_HANDLE",
    ]);
  }
  if (facts.operator !== null)
    return { kind: "person", principal: facts.operator };
  throw identityMissing("this run names no operator and no Seat", [
    "set operator: <principal> in $POD_HOME/host.yaml",
    agentStep,
  ]);
}

export function actorOf(identity: Identity): string {
  return identity.kind === "seat"
    ? `seat:${identity.address}`
    : `person:${identity.principal}`;
}

export function needsPerson(
  identity: Identity,
  need: PersonNeed,
): asserts identity is Extract<Identity, { kind: "person" }> {
  if (identity.kind === "seat")
    throw new PodError(
      "activation_needs_person",
      3,
      `${actorOf(identity)} is an agent Seat, and ${need.what} needs a person`,
      need.nextSteps,
    );
}

async function checkPrincipal(repo: Repo, principal: string): Promise<void> {
  const policy = await singleActive(repo, "policy", "global", "");
  const names = Object.keys(principalsOf(policy?.value));
  if (names.length === 0 || names.includes(principal)) return;
  throw identityMissing(
    `operator ${principal} is not a principal of the active global policy`,
    [`set operator: in $POD_HOME/host.yaml to one of ${names.join(", ")}`],
  );
}

export async function writerOf(
  repo: Repo,
  host: HostSettings,
  env: Env,
  need: PersonNeed | null,
): Promise<Identity> {
  const podSeat = seatFromEnv(env);
  const handle = envValue(env, "ORCA_TERMINAL_HANDLE");
  const recordedSeat =
    podSeat !== null || handle === null
      ? null
      : await repo.terminalSeat(host.hostId, handle);
  const seated = podSeat !== null || recordedSeat !== null;
  const identity = resolveIdentity(
    {
      podSeat,
      recordedSeat,
      handle,
      unresolved: seated ? [] : await repo.unresolvedWorkers(host.hostId),
      operator: host.operator,
    },
    need,
  );
  if (identity.kind === "person")
    await checkPrincipal(repo, identity.principal);
  return identity;
}
