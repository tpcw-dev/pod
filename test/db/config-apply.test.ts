import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { stringify } from "yaml";
import { clearDb, describeDb, openDb, resetDb, runCli } from "./helpers.ts";
import { crewValue, processValue } from "./seed.ts";

const dir = mkdtempSync(join(tmpdir(), "pod-apply-"));

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const v1 = file(
  "v1.yaml",
  "kind: policy\nname: demo\nschema_version: 1\nvalue:\n  steps: [a, b]\n",
);
const v2 = file(
  "v2.yaml",
  "kind: policy\nname: demo\nschema_version: 1\nvalue:\n  steps: [a, b, c]\n",
);
const v3 = file(
  "v3.yaml",
  "kind: policy\nname: demo\nschema_version: 1\nvalue:\n  steps: [c]\n",
);

describeDb("pod config apply and export", () => {
  let db: Connection;
  let v1Id = "";
  let v2Id = "";

  beforeAll(async () => {
    await resetDb();
    db = openDb();
  });
  afterAll(() => db.close());

  async function operationStatus(opKey: string): Promise<string | undefined> {
    const rows = await db.sql<
      { status: string }[]
    >`select status from ledger.operation where op_key = ${opKey}`;
    return rows[0]?.status;
  }

  test("an apply returns kind.name@rev", () => {
    const result = runCli(["config", "apply", v1]);
    expect(result).toMatchObject({
      status: 0,
      json: {
        ok: true,
        result: {
          ref: "policy.demo@1",
          rev: 1,
          created: true,
          activation: null,
        },
      },
    });
    v1Id = String(result.json.result?.["id"]);
    expect(v1Id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the same file again returns the same id and rev", () => {
    expect(runCli(["config", "apply", v1]).json.result).toMatchObject({
      id: v1Id,
      rev: 1,
      created: false,
    });
  });

  test("an export applies again to the same id and rev", () => {
    const out = join(dir, "export.yaml");
    expect(
      runCli(["config", "export", "policy.demo@1", "--out", out]).json,
    ).toMatchObject({
      ok: true,
      result: { ref: "policy.demo@1", id: v1Id, out },
    });
    expect(runCli(["config", "apply", out]).json.result).toMatchObject({
      id: v1Id,
      rev: 1,
      created: false,
    });
  });

  test("an export of an unknown ref is revision_not_found", () => {
    const result = runCli([
      "config",
      "export",
      "process.demo@9",
      "--out",
      join(dir, "none.yaml"),
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("revision_not_found");
  });

  test("a first activation records the operation and the activation event", async () => {
    const result = runCli([
      "config",
      "apply",
      v1,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(result.status).toBe(0);
    const activation = result.json.result?.["activation"] as { op_key: string };
    expect(activation).toMatchObject({
      revision_id: v1Id,
      previous_revision_id: null,
      bundle_id: null,
    });
    expect(await operationStatus(activation.op_key)).toBe("done");
    const events =
      await db.sql`select host, payload, source from ledger.event where op_key = ${activation.op_key}`;
    expect(events).toEqual([
      {
        host: "local",
        payload: {
          scope: "global",
          scope_ref: "",
          kind: "policy",
          name: "demo",
          revision_id: v1Id,
          previous_revision_id: null,
          bundle_id: null,
        },
        source: { kind: "command", verb: "config apply" },
      },
    ]);
    const again = runCli([
      "config",
      "apply",
      v1,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(again.json.result).toEqual(result.json.result);
  });

  test("a second none is revision_conflict and leaves a refused operation", async () => {
    const result = runCli([
      "config",
      "apply",
      v2,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      "none",
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("revision_conflict");
    expect(result.json.error?.nextSteps[0]).toBe(
      "pod config export policy.demo@1 --out FILE",
    );
    const rows = await db.sql<
      { status: string }[]
    >`select status from ledger.operation where status = 'refused'`;
    expect(rows).toHaveLength(1);
  });

  test("an activation with the active id moves forward", () => {
    const result = runCli([
      "config",
      "apply",
      v2,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      v1Id,
    ]);
    expect(result.status).toBe(0);
    v2Id = String(result.json.result?.["id"]);
    expect(result.json.result).toMatchObject({
      ref: "policy.demo@2",
      activation: { revision_id: v2Id, previous_revision_id: v1Id },
    });
  });

  test("a stale expected revision is revision_conflict and leaves a refused operation", async () => {
    const result = runCli([
      "config",
      "apply",
      v3,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      v1Id,
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error).toMatchObject({
      code: "revision_conflict",
      nextSteps: [
        "pod config export policy.demo@2 --out FILE",
        `pod config apply ${v3} --activate --scope global --expected-revision ${v2Id}`,
      ],
    });
    const rows =
      await db.sql`select status from ledger.operation where status = 'refused'`;
    expect(rows).toHaveLength(2);
    const [active] = await db.sql<
      { revision_id: string }[]
    >`select revision_id from config.activation`;
    expect(active?.revision_id).toBe(v2Id);
  });

  test("an op key another intent holds is duplicate_op", async () => {
    await db.sql`insert into ledger.operation (op_key, intent, status, owner_generation, created_at, updated_at)
      values ('taken', 'drain', 'done', 1, now(), now())`;
    const result = runCli([
      "config",
      "apply",
      v3,
      "--activate",
      "--scope",
      "global",
      "--expected-revision",
      v2Id,
      "--op-key",
      "taken",
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("duplicate_op");
  });

  test("an envelope missing kind is schema_invalid at kind", () => {
    const path = file(
      "nokind.yaml",
      "name: demo\nschema_version: 1\nvalue: {}\n",
    );
    const result = runCli(["config", "apply", path]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(result.json.error?.nextSteps[0]).toMatch(/^kind: /);
  });

  test("an unknown parent is schema_invalid at parent", () => {
    const path = file(
      "orphan.yaml",
      `kind: process\nname: demo\nschema_version: 1\nparent: "${"0".repeat(64)}"\nvalue: {}\n`,
    );
    const result = runCli(["config", "apply", path]);
    expect(result.status).toBe(2);
    expect(result.json.error?.code).toBe("schema_invalid");
    expect(result.json.error?.nextSteps[0]).toMatch(/^parent: /);
  });

  test("a duplicate key is schema_invalid", () => {
    const path = file(
      "dup.yaml",
      "kind: process\nkind: crew\nname: demo\nschema_version: 1\nvalue: {}\n",
    );
    expect(runCli(["config", "apply", path])).toMatchObject({
      status: 2,
      json: { error: { code: "schema_invalid" } },
    });
  });

  test("flags that disagree are usage", () => {
    for (const args of [
      ["config", "apply", v1, "--expected-revision", "none"],
      ["config", "apply", v1, "--activate", "--scope", "global"],
      [
        "config",
        "apply",
        v1,
        "--activate",
        "--scope",
        "project:p1",
        "--expected-revision",
        "none",
      ],
      [
        "config",
        "apply",
        v1,
        "--activate",
        "--scope",
        "global",
        "--expected-revision",
        "abc",
      ],
      ["config", "apply", v1, "--out", "x"],
      ["config", "export", "process.demo", "--out", "x"],
    ]) {
      expect(runCli(args), args.join(" ")).toMatchObject({
        status: 2,
        json: { error: { code: "usage" } },
      });
    }
  });

  test("a raw UPDATE on a Revision raises", async () => {
    await expect(
      db.sql`update config.revision set reason = 'edited' where id = ${v1Id}`,
    ).rejects.toMatchObject({
      code: "P0001",
    });
  });
});

function envelopeFile(
  name: string,
  kind: string,
  value: Record<string, unknown>,
): string {
  return file(
    `${name}.yaml`,
    stringify({ kind, name, schema_version: 1, value }),
  );
}

function activate(path: string, expected = "none") {
  return runCli([
    "config",
    "apply",
    path,
    "--activate",
    "--scope",
    "global",
    "--expected-revision",
    expected,
  ]);
}

const hold = ["timeout", "cancel", "unknown"];

describeDb("pod config apply of a process", () => {
  let db: Connection;

  beforeAll(async () => {
    db = openDb();
  });
  afterAll(() => db.close());

  async function counts() {
    const [row] = await db.sql<{ revisions: number; operations: number }[]>`
      select
        (select count(*)::int from config.revision where kind = 'process') as revisions,
        (select count(*)::int from ledger.operation) as operations`;
    return row;
  }

  async function seedCrewAndPolicy(
    crew: Record<string, unknown> = crewValue,
    gates: unknown = ["pr"],
  ) {
    expect(activate(envelopeFile("policy", "policy", { gates })).status).toBe(
      0,
    );
    expect(activate(envelopeFile("crew", "crew", crew)).status).toBe(0);
  }

  test("a process before any crew is selector_none and writes nothing", async () => {
    await clearDb(db);
    const result = activate(envelopeFile("early", "process", processValue));
    expect(result.status).toBe(3);
    expect(result.json.error).toMatchObject({
      code: "selector_none",
      message: "no single active global crew Revision",
    });
    expect(await counts()).toEqual({ revisions: 0, operations: 0 });
  });

  test("a project process with no crew names the project scope in its next step", async () => {
    await clearDb(db);
    const path = file(
      "project.yaml",
      stringify({
        kind: "process",
        name: "scoped",
        schema_version: 1,
        scope: "project",
        scope_ref: "p1",
        value: processValue,
      }),
    );
    const result = runCli(["config", "apply", path]);
    expect(result.status).toBe(3);
    expect(result.json.error).toMatchObject({
      code: "selector_none",
      message: "no single active project crew Revision",
      nextSteps: [
        "pod config apply crew.yaml --activate --scope project:p1 --expected-revision none",
      ],
    });
  });

  const refused: {
    name: string;
    value: Record<string, unknown>;
    code: string;
    exit: number;
    message: string;
  }[] = [
    {
      name: "an unreachable step",
      value: {
        ...processValue,
        steps: [
          ...processValue.steps,
          { id: "lonely", type: "worker", role: "developer" },
        ],
        edges: [
          ...processValue.edges,
          { from: "lonely", on: "done", to: "done" },
          { from: "lonely", on: hold, to: "hold" },
        ],
      },
      code: "schema_invalid",
      exit: 2,
      message: "steps.2: step lonely is not reachable from build",
    },
    {
      name: "a role no seat holds",
      value: { ...processValue, roles: ["developer", "reviewer", "auditor"] },
      code: "role_unfilled",
      exit: 3,
      message: "no crew seat holds role auditor",
    },
    {
      name: "a gate the policy lacks",
      value: {
        ...processValue,
        steps: [
          processValue.steps[0],
          { ...processValue.steps[1], gate: "ship" },
        ],
      },
      code: "schema_invalid",
      exit: 2,
      message: "steps.1.gate: gate ship is not in the active policy",
    },
  ];

  test.each(refused)(
    "$name is $code with no Revision and no operation",
    async (c) => {
      await clearDb(db);
      await seedCrewAndPolicy();
      const before = await counts();
      const path = envelopeFile("refused", "process", c.value);
      for (const result of [
        runCli(["config", "apply", path]),
        activate(path),
      ]) {
        expect(result.status).toBe(c.exit);
        expect(result.json.error?.code).toBe(c.code);
        expect(result.json.error?.message).toContain(c.message);
        expect(result.json.error?.nextSteps).toHaveLength(1);
      }
      expect(await counts()).toEqual(before);
    },
  );

  test("a reviewer who also develops is reviewer_not_independent with no Revision and no operation", async () => {
    await clearDb(db);
    await seedCrewAndPolicy({
      seats: [
        { id: "dev-1", roles: ["developer"], runtime: "claude" },
        { id: "both-1", roles: ["developer", "reviewer"], runtime: "claude" },
      ],
    });
    const before = await counts();
    const result = activate(envelopeFile("seeded", "process", processValue));
    expect(result.status).toBe(3);
    expect(result.json.error).toMatchObject({
      code: "reviewer_not_independent",
      message: "step review: no seat with role reviewer is free of developer",
    });
    expect(await counts()).toEqual(before);
  });

  test("a refused --activate leaves the active Revision as it was", async () => {
    await clearDb(db);
    await seedCrewAndPolicy();
    const good = activate(envelopeFile("flow", "process", processValue));
    expect(good.status).toBe(0);
    const id = String(good.json.result?.["id"]);
    const bad = activate(
      envelopeFile("flow", "process", { ...processValue, roles: ["auditor"] }),
      id,
    );
    expect(bad.json.error?.code).toBe("role_unfilled");
    const active = await db.db.getActivation({
      scope: "global",
      scope_ref: "",
      kind: "process",
      name: "flow",
    });
    expect(active?.revision_id).toBe(id);
  });

  test("specs/process/impl-small.yaml applies after a fitting crew and policy", async () => {
    await clearDb(db);
    const seats = (reviewer: string[]) => ({
      seats: [
        { id: "dev-1", roles: ["developer"], runtime: "claude" },
        { id: "rev-1", roles: reviewer, runtime: "codex" },
      ],
    });
    await seedCrewAndPolicy(seats(["developer", "reviewer"]), {
      review: { keeper: "rev-1", type: "AQA" },
      merge: { keeper: "lead", type: "AQA" },
      hqa_after_deploy: { keeper: "operator", type: "HQA" },
    });
    const dependent = activate("specs/process/impl-small.yaml");
    expect(dependent.status).toBe(3);
    expect(dependent.json.error).toMatchObject({
      code: "reviewer_not_independent",
      message: expect.stringContaining("step review"),
    });
    const crew = await db.db.getActivation({
      scope: "global",
      scope_ref: "",
      kind: "crew",
      name: "crew",
    });
    expect(
      activate(
        envelopeFile("crew", "crew", seats(["reviewer"])),
        crew?.revision_id,
      ).status,
    ).toBe(0);
    const applied = activate("specs/process/impl-small.yaml");
    expect(applied.status).toBe(0);
    expect(applied.json.result).toMatchObject({ ref: "process.impl-small@1" });
  });

  function roadmapPolicy(name: string, roadmap: unknown): string {
    return file(
      `${name}.yaml`,
      stringify({
        kind: "policy",
        name,
        schema_version: 1,
        value: { steps: [], roadmap },
      }),
    );
  }

  test("a roadmap whose provider is not the host docs kind is config_invalid at roadmap.provider", async () => {
    const before = await db.sql`select count(*)::int as n from config.revision`;
    const result = runCli([
      "config",
      "apply",
      roadmapPolicy("map-linear", { provider: "linear", page: "x" }),
    ]);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("config_invalid");
    expect(result.json.error?.message).toMatch(/^roadmap\.provider /);
    expect(
      await db.sql`select count(*)::int as n from config.revision`,
    ).toEqual(before);
  });

  test("a roadmap with an empty page or no object is config_invalid naming the field", () => {
    const empty = runCli([
      "config",
      "apply",
      roadmapPolicy("map-empty", { provider: "notion", page: "  " }),
    ]);
    expect(empty.status).toBe(3);
    expect(empty.json.error?.code).toBe("config_invalid");
    expect(empty.json.error?.message).toMatch(/^roadmap\.page /);
    const scalar = runCli([
      "config",
      "apply",
      roadmapPolicy("map-scalar", "x"),
    ]);
    expect(scalar.json.error?.code).toBe("config_invalid");
    expect(scalar.json.error?.message).toMatch(/^roadmap /);
  });

  test("a roadmap on the host docs kind with a page applies", () => {
    const result = runCli([
      "config",
      "apply",
      roadmapPolicy("map-notion", {
        provider: "notion",
        page: "00000000-0000-4000-8000-000000000001",
      }),
    ]);
    expect(result.status).toBe(0);
    expect(result.json.result).toMatchObject({ ref: "policy.map-notion@1" });
  });

  const gatePolicy = Object.fromEntries(
    [
      "audit",
      "prd_review",
      "taste_qa",
      "design_clickthrough",
      "plan_review",
      "story_qa",
      "review",
      "integration_review",
      "merge",
      "hqa_after_deploy",
    ].map((gate) => [gate, { keeper: "keeper", type: "AQA" }]),
  );
  const extendedCrew = {
    seats: [
      ...crewValue.seats,
      ...[
        "writer",
        "auditor",
        "designer",
        "taste_reviewer",
        "planner",
        "qa",
      ].map((role) => ({ id: `${role}-1`, roles: [role], runtime: "claude" })),
    ],
  };

  test.each(["prd", "design", "impl-medium", "impl-large", "impl-xlarge"])(
    "specs/process/%s.yaml applies against the extended seed crew",
    async (name) => {
      await clearDb(db);
      await seedCrewAndPolicy(extendedCrew, gatePolicy);
      const applied = activate(`specs/process/${name}.yaml`);
      expect(applied.status).toBe(0);
      expect(applied.json.result).toMatchObject({ ref: `process.${name}@1` });
    },
  );

  test("specs/process/impl-medium.yaml against the two-seat seed crew is role_unfilled naming planner", async () => {
    await clearDb(db);
    await seedCrewAndPolicy(
      {
        seats: [
          { id: "dev-1", roles: ["developer"], runtime: "claude" },
          { id: "rev-1", roles: ["reviewer"], runtime: "codex" },
        ],
      },
      gatePolicy,
    );
    const before = await counts();
    for (const refused of [
      runCli(["config", "apply", "specs/process/impl-medium.yaml"]),
      activate("specs/process/impl-medium.yaml"),
    ]) {
      expect(refused.status).toBe(3);
      expect(refused.json.error).toMatchObject({
        code: "role_unfilled",
        message: "no crew seat holds role planner",
      });
    }
    expect(await counts()).toEqual(before);
  });
});
