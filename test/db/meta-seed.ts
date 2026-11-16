import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { Kind, Scope } from "../../src/core/domain/config.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { makeFixtureCodeHost } from "../../src/adapters/code-host/fixture.ts";
import { receiptLog } from "../../src/core/ledger/receipts.ts";
import {
  metaStepsWith,
  type MetaDeps,
  type MetaInput,
  type MetaOutcome,
  type MetaStep,
} from "../../src/core/operate/meta.ts";
import { unbuiltSeat } from "../../src/core/operate/meta-digest.ts";
import { noCalls } from "../orca/temp-fixtures.ts";
import type { Refused } from "../../src/core/domain/outcome.ts";
import { envelope, storeRevision } from "./fixtures.ts";
import { hostValue } from "./seed.ts";

export const host = "local";
export const morning = {
  name: "morning",
  at: "05:00",
  steps: ["retro", "digest"],
};
export const packetPolicy = {
  limits: { packet_items: 20, packet_words: 2000, packet_minutes: 30 },
};

export async function activate(
  conn: Connection,
  kind: Kind,
  name: string,
  scope: Scope,
  scopeRef: string,
  value: Json,
): Promise<string> {
  const revision = await storeRevision(conn.db, {
    ...envelope(kind, name, value),
    scope,
    scope_ref: scopeRef,
  });
  const [active] = await conn.db.listActivations(kind, scope, scopeRef);
  const activated = await conn.db.activate({
    scope,
    scope_ref: scopeRef,
    kind,
    name,
    expected: active?.revision_id ?? null,
    revision_id: revision.id,
    bundle_id: null,
    activated_by: "operator",
    activated_at: new Date("2026-11-01T00:00:00Z"),
  });
  if (!activated.ok) throw new Error(`${kind} not activated`);
  return revision.id;
}

/** Activates a host (America/New_York), its schedule, and a global policy. */
export async function seedMeta(
  conn: Connection,
  slots: Json[] = [morning],
  policy: Json = packetPolicy,
): Promise<string> {
  await activate(conn, "host", host, "host", host, hostValue(2));
  await activate(conn, "policy", "default", "global", "", policy);
  return activate(conn, "schedule", "default", "host", host, {
    tick_minutes: 15,
    hold_minutes: 60,
    meta_slots: slots,
  });
}

export function metaInput(now: Date, slot?: string): MetaInput {
  return {
    host,
    writer: host,
    actor: "person:human",
    now,
    ...(slot === undefined ? {} : { slot }),
  };
}

export function ran(outcome: MetaOutcome | Refused): MetaOutcome {
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome;
}

export function metaTable(
  conn: Connection,
  over: Partial<MetaDeps> = {},
): readonly MetaStep[] {
  return metaStepsWith({
    orca: noCalls(),
    log: receiptLog(conn.db, host),
    codeHost: makeFixtureCodeHost({ prs: [] }),
    seat: unbuiltSeat,
    ...over,
  });
}
