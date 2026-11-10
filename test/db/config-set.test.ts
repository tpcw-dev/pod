import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { applyConfig } from "../../src/core/config/apply.ts";
import { deriveSet } from "../../src/core/config/set.ts";
import type { Revision } from "../../src/core/domain/config.ts";
import { clearDb, openDb, resetDb, runCli } from "./helpers.ts";
import { operator } from "./identity-fixture.ts";
import { activeRevision, crewValue } from "./seed.ts";

const reason = ["--reason", "test edit"];

describe("pod config set", () => {
  let db: Connection;
  let source: Revision;

  beforeAll(async () => {
    await resetDb();
    db = openDb();
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await clearDb(db);
    source = await activeRevision(db.db, "crew", "team", crewValue);
  });

  async function revision(
    id: unknown,
  ): Promise<Revision & { ticket?: unknown }> {
    const found = await db.db.getRevision(String(id));
    if (found === null) throw new Error(`no Revision ${String(id)}`);
    return found;
  }

  async function revisionCount(): Promise<number> {
    const [row] = await db.sql<
      { n: number }[]
    >`select count(*)::int as n from config.revision`;
    return row?.n ?? 0;
  }

  function seats(value: unknown): Record<string, unknown>[] {
    return (value as { seats: Record<string, unknown>[] }).seats;
  }

  test("path and [n] edits make one Revision whose parent is the source", async () => {
    const result = runCli([
      "config",
      "set",
      "crew.team",
      "seats[1].model=m-2",
      "seats[0].effort=high",
      ...reason,
    ]);
    expect(result.status).toBe(0);
    expect(result.json.result).toMatchObject({
      ref: "crew.team@2",
      rev: 2,
      created: true,
      activation: null,
    });
    const made = await revision(result.json.result?.["id"]);
    expect(made.parent).toBe(source.id);
    expect(made.reason).toBe("test edit");
    expect(seats(made.value)[1]).toMatchObject({ id: "rev-1", model: "m-2" });
    expect(seats(made.value)[0]).toMatchObject({ id: "dev-1", effort: "high" });
    expect(await revisionCount()).toBe(2);
  });

  test("values parse as YAML flow, and --string keeps them as text", async () => {
    const typed = runCli([
      "config",
      "set",
      "crew.team",
      "limits={max: 3, tags: [a, b], on: true}",
      ...reason,
    ]);
    expect(typed.status).toBe(0);
    const made = await revision(typed.json.result?.["id"]);
    expect((made.value as Record<string, unknown>)["limits"]).toEqual({
      max: 3,
      tags: ["a", "b"],
      on: true,
    });
    const text = runCli([
      "config",
      "set",
      "crew.team",
      "seats[0].model=3",
      "--string",
      ...reason,
    ]);
    expect(text.status).toBe(0);
    const kept = await revision(text.json.result?.["id"]);
    expect(seats(kept.value)[0]?.["model"]).toBe("3");
  });

  test("--unset removes a path", async () => {
    const result = runCli([
      "config",
      "set",
      "crew.team",
      "--unset",
      "seats[0].effort",
      "--unset",
      "seats[0].model",
      ...reason,
    ]);
    expect(result.status).toBe(0);
    const made = await revision(result.json.result?.["id"]);
    expect(seats(made.value)[0]).toEqual({
      id: "dev-1",
      roles: ["developer"],
      runtime: "claude",
    });
  });

  test("a malformed path, a missing index, or an unset of a missing path is usage", () => {
    for (const edit of [
      ["seats[x].model=a"],
      ["seats[9].model=a"],
      ["seats.model=a"],
      ["--unset", "seats[0].nothing"],
      ["no-equals-sign"],
    ]) {
      const result = runCli(["config", "set", "crew.team", ...edit, ...reason]);
      expect(result.status, edit.join(" ")).toBe(2);
      expect(result.json.error?.code).toBe("usage");
    }
  });

  test("a set needs --reason", () => {
    const result = runCli(["config", "set", "crew.team", "seats[0].model=a"]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("usage");
  });

  test("the edited value is revalidated by its kind's schema", async () => {
    const result = runCli([
      "config",
      "set",
      "crew.team",
      "seats[0].fallback=nobody",
      ...reason,
    ]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(await revisionCount()).toBe(1);
  });

  test("with no active Revision the set is refused and points at config apply", () => {
    const result = runCli([
      "config",
      "set",
      "crew.other",
      "seats[0].model=a",
      ...reason,
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("revision_not_found");
    expect(result.json.error?.nextSteps).toContain("pod config apply FILE");
  });

  test("--from derives from an inactive Revision", async () => {
    const pending = runCli([
      "config",
      "set",
      "crew.team",
      "seats[0].model=m-pending",
      ...reason,
    ]);
    expect(pending.status).toBe(0);
    const derived = runCli([
      "config",
      "set",
      "crew.team",
      "seats[1].model=m-next",
      "--from",
      "crew.team@2",
      ...reason,
    ]);
    expect(derived.status).toBe(0);
    const made = await revision(derived.json.result?.["id"]);
    expect(made.parent).toBe(pending.json.result?.["id"]);
    expect(seats(made.value)[0]?.["model"]).toBe("m-pending");
    expect(seats(made.value)[1]?.["model"]).toBe("m-next");
  });

  test("--activate activates the new Revision in place of the source", async () => {
    const result = runCli([
      "config",
      "set",
      "crew.team",
      "seats[1].model=m-2",
      "--activate",
      "--ticket",
      "ABC-1",
      ...reason,
    ]);
    expect(result.status).toBe(0);
    expect(result.json.result?.["activation"]).toMatchObject({
      previous_revision_id: source.id,
      revision_id: result.json.result?.["id"],
    });
    const [row] = await db.sql<
      { activated_by: string; actor: string; ticket: string | null }[]
    >`select a.activated_by, r.actor, r.ticket
      from config.activation a join config.revision r on r.id = a.revision_id
      where a.kind = 'crew' and a.name = 'team'`;
    expect(row).toEqual({
      activated_by: `person:${operator}`,
      actor: `person:${operator}`,
      ticket: "ABC-1",
    });
    const [event] = await db.sql<
      { source: unknown }[]
    >`select source from ledger.event where type = 'activation'`;
    expect(event?.source).toEqual({ kind: "command", verb: "config set" });
  });

  test("--activate returns revision_conflict when the active Revision changed after the read", async () => {
    const derived = await deriveSet(db.db, {
      kind: "crew",
      name: "team",
      scope: { scope: "global", scope_ref: "" },
      from: null,
      edits: [{ op: "set", path: ["seats", 1, "model"], value: "m-2" }],
    });
    if (derived.kind !== "ok") throw new Error(derived.kind);
    const between = runCli([
      "config",
      "set",
      "crew.team",
      "seats[1].model=m-between",
      "--activate",
      ...reason,
    ]);
    expect(between.status).toBe(0);
    const outcome = await applyConfig(db.db, {
      envelope: derived.envelope,
      actor: `person:${operator}`,
      reason: "late",
      now: new Date(),
      activate: { expected: derived.expected, opKey: null, host: "local" },
      verb: "config set",
    });
    expect(outcome.kind).toBe("revision_conflict");
  });

  test("a Seat writes as seat:<address> and cannot activate", async () => {
    const written = runCli(
      ["config", "set", "crew.team", "seats[1].model=m-2", ...reason],
      { POD_SEAT: "developer" },
    );
    expect(written.status).toBe(0);
    expect((await revision(written.json.result?.["id"])).actor).toBe(
      "seat:developer",
    );
    const before = await revisionCount();
    const refused = runCli(
      [
        "config",
        "set",
        "crew.team",
        "seats[1].model=m-3",
        "--activate",
        ...reason,
      ],
      { POD_SEAT: "developer" },
    );
    expect(refused.status).toBe(3);
    expect(refused.json.error?.code).toBe("activation_needs_person");
    expect(await revisionCount()).toBe(before);
  });

  test("an operator that is not a principal of the active global policy is identity_missing", async () => {
    await activeRevision(db.db, "policy", "default", {
      gates: [],
      principals: { someone: { tracker_account: "acct-1" } },
    });
    const result = runCli([
      "config",
      "set",
      "crew.team",
      "seats[1].model=m-2",
      ...reason,
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("identity_missing");
    expect(result.json.error?.nextSteps.join(" ")).toContain("someone");
  });
});
