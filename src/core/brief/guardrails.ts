import { z } from "zod";
import { singleActive } from "../config/active.ts";
import { intents, type Event, type Operation } from "../domain/ledger.ts";
import { reservedOf } from "../domain/policy.ts";
import type { Repo } from "../ports/db.ts";

export const GuardrailRow = z.object({
  name: z.string(),
  kind: z.enum(["code", "hold", "escalate", "reserved"]),
  days_7: z.number(),
  days_30: z.number(),
  sunset_candidate: z.boolean(),
});
export type GuardrailRow = z.infer<typeof GuardrailRow>;

const day = 86_400_000;
const RefusedCode = z.looseObject({ code: z.string() });
const ReservedFire = z.looseObject({
  outcome: z.literal("reserved_needs_human"),
  reserved: z.looseObject({ member: z.string() }),
});

export interface GuardrailInput {
  codes: readonly string[];
  reservedNeedsHuman: readonly string[];
  refused: readonly Operation[];
  events: readonly Event[];
  now: Date;
}

function fireOf(event: Event): string | null {
  if (event.type === "hold" || event.type === "escalate") return event.type;
  if (event.type !== "decision") return null;
  const fire = ReservedFire.safeParse(event.payload);
  return fire.success ? `reserved:${fire.data.reserved.member}` : null;
}

export function guardrailsOf(input: GuardrailInput): GuardrailRow[] {
  const now = input.now.getTime();
  const fires = new Map<string, number[]>();
  const fired = (name: string, at: Date) => {
    const age = now - at.getTime();
    if (age < 0 || age >= 30 * day) return;
    fires.set(name, [...(fires.get(name) ?? []), age]);
  };
  const codes = new Set(input.codes);
  for (const operation of input.refused) {
    const code = RefusedCode.safeParse(operation.result_ref).data?.code;
    if (code !== undefined && codes.has(code))
      fired(code, operation.updated_at);
  }
  for (const event of input.events) {
    const name = fireOf(event);
    if (name !== null) fired(name, event.ts);
  }
  const members = new Set(
    input.reservedNeedsHuman.map((member) => `reserved:${member}`),
  );
  for (const name of fires.keys())
    if (name.startsWith("reserved:")) members.add(name);
  const rows: [string, GuardrailRow["kind"]][] = [
    ...input.codes.map((code): [string, "code"] => [code, "code"]),
    ["hold", "hold"],
    ["escalate", "escalate"],
    ...[...members]
      .sort()
      .map((name): [string, "reserved"] => [name, "reserved"]),
  ];
  return rows.map(([name, kind]) => {
    const ages = fires.get(name) ?? [];
    return {
      name,
      kind,
      days_7: ages.filter((age) => age < 7 * day).length,
      days_30: ages.length,
      sunset_candidate: ages.length === 0,
    };
  });
}

export async function readGuardrails(
  repo: Repo,
  codes: readonly string[],
  now: Date,
): Promise<GuardrailRow[]> {
  const policy = await singleActive(repo, "policy", "global", "");
  return guardrailsOf({
    codes,
    reservedNeedsHuman: reservedOf(policy?.value).needs_human.map(
      (member) => member.name,
    ),
    refused: await repo.listOperations(intents, ["refused"]),
    events: await repo.eventsBetween(new Date(now.getTime() - 30 * day), now),
    now,
  });
}
