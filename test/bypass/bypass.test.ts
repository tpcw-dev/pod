import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { z } from "zod";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { envelope } from "../db/fixtures.ts";
import { clearDb, openDb, resetDb, runCli } from "../db/helpers.ts";
import {
  openLaunch,
  operator,
  seatDispatch,
  seatRun,
} from "../db/identity-fixture.ts";
import { relayBody } from "./relay.ts";

const envNames = [
  "POD_BYPASS_ENDPOINT",
  "POD_BYPASS_WORKER_TOKEN",
  "POD_BYPASS_WORKER_ACTOR",
  "POD_BYPASS_KEEPER_ACTOR",
  "POD_BYPASS_RELAY_ACTOR",
  "POD_BYPASS_STORY",
] as const;

type EnvName = (typeof envNames)[number];

function isReady(
  values: Partial<Record<EnvName, string>>,
): values is Record<EnvName, string> {
  return envNames.every((name) => {
    const value = values[name];
    return value !== undefined && value !== "";
  });
}

function readEnv(): Record<EnvName, string> | undefined {
  const values: Partial<Record<EnvName, string>> = {};
  for (const name of envNames) {
    const value = process.env[name];
    if (value === undefined || value === "") return undefined;
    values[name] = value;
  }
  if (!isReady(values)) return undefined;
  return values;
}

const ready = readEnv();

const payloadSchema = z.object({
  data: z
    .object({
      commentCreate: z
        .object({
          success: z.boolean(),
          comment: z
            .object({
              id: z.string(),
              user: z.object({ id: z.string() }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z
    .array(
      z
        .object({
          message: z.string(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .passthrough(),
    )
    .optional(),
});

type Payload = z.infer<typeof payloadSchema>;

function isCreateAsUserRejection(payload: Payload): boolean {
  const comment = payload.data?.commentCreate?.comment ?? null;
  return (
    comment === null &&
    (payload.errors ?? []).some(
      (item) =>
        item.message.includes("createAsUser") ||
        (item.path ?? []).includes("createAsUser"),
    )
  );
}

const mutation = `mutation ($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body user { id } }
  }
}`;

function redact(text: string, token: string): string {
  return text.split(token).join("[redacted]");
}

function report(result: "pass" | "fail"): void {
  process.stdout.write(`${JSON.stringify({ host: hostname(), result })}\n`);
  const home = process.env["POD_HOME"];
  if (home === undefined || home === "") return;
  mkdirSync(home, { recursive: true });
  const line = { host: hostname(), result, at: new Date().toISOString() };
  appendFileSync(join(home, "bypass.jsonl"), `${JSON.stringify(line)}\n`);
}

test("a rejection names createAsUser in its message or its path", () => {
  const rejection = (error: { message: string; path?: string[] }): Payload => ({
    data: { commentCreate: null },
    errors: [error],
  });
  expect(
    isCreateAsUserRejection(
      rejection({ message: "createAsUser is not allowed for this token" }),
    ),
  ).toBe(true);
  expect(
    isCreateAsUserRejection(
      rejection({
        message: "Argument Validation Error",
        path: ["commentCreate", "input", "createAsUser"],
      }),
    ),
  ).toBe(true);
  expect(
    isCreateAsUserRejection(
      rejection({
        message: "Argument Validation Error",
        path: ["commentCreate"],
      }),
    ),
  ).toBe(false);
});

test.skipIf(ready === undefined)(
  "worker posts land as the worker and the relay posts no PASS",
  async () => {
    const env = ready;
    if (env === undefined) return;
    const token = env.POD_BYPASS_WORKER_TOKEN;
    try {
      expect(relayBody(null, "PASS")).toBeNull();
      expect(relayBody("ship it", "PASS")).toBe("ship it");
      const actors = new Set([
        env.POD_BYPASS_WORKER_ACTOR,
        env.POD_BYPASS_KEEPER_ACTOR,
        env.POD_BYPASS_RELAY_ACTOR,
      ]);
      expect(actors.size).toBe(3);
      await post(env, token, "gatekeeper", "bypass-keeper-attempt");
      await post(env, token, "relay", "bypass-relay-attempt");
      report("pass");
    } catch (error) {
      report("fail");
      const message = error instanceof Error ? error.message : "bypass failed";
      throw new Error(redact(message, token));
    }
  },
);

async function post(
  env: Record<EnvName, string>,
  token: string,
  createAsUser: string,
  body: string,
): Promise<void> {
  const response = await fetch(env.POD_BYPASS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: { issueId: env.POD_BYPASS_STORY, body, createAsUser },
      },
    }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      redact(`tracker response was not json (${response.status})`, token),
    );
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      redact("tracker response did not match the comment payload", token),
    );
  }
  if (isCreateAsUserRejection(parsed.data)) return;
  const comment = parsed.data.data?.commentCreate?.comment ?? null;
  if (comment !== null && comment.user.id === env.POD_BYPASS_WORKER_ACTOR)
    return;
  const actor = comment?.user.id ?? "none";
  throw new Error(redact(`actor ${actor}`, token));
}

describe("a worker-level terminal cannot activate as the operator", () => {
  let db: Connection;
  const file = join(
    mkdtempSync(join(tmpdir(), "pod-bypass-")),
    "crew.yaml",
  );
  writeFileSync(
    file,
    stringify(
      envelope("crew", "bypass", {
        seats: [{ id: "dev", roles: ["developer"], runtime: "claude" }],
      }),
    ),
  );
  const activate = [
    "config",
    "apply",
    file,
    "--activate",
    "--scope",
    "global",
    "--expected-revision",
    "none",
  ];

  beforeAll(async () => {
    await resetDb();
    db = openDb();
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await clearDb(db);
    await seatRun(db.db, "run-1");
  });

  async function stored(): Promise<number> {
    const [row] = await db.sql<
      { n: number }[]
    >`select count(*)::int as n from config.revision`;
    return row?.n ?? 0;
  }

  test("a worker in the terminal Pod recorded is refused activation_needs_person", async () => {
    await seatDispatch(db.db, {
      runId: "run-1",
      dispatchId: "d-1",
      seat: "dev",
      terminal: "term-worker",
    });
    const result = runCli(activate, { ORCA_TERMINAL_HANDLE: "term-worker" });
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("activation_needs_person");
    expect(await stored()).toBe(0);
  });

  test("the Run's coordinator terminal is refused activation_needs_person", async () => {
    await seatRun(db.db, "run-2", { coordinator: "term-coordinator" });
    const result = runCli(activate, {
      ORCA_TERMINAL_HANDLE: "term-coordinator",
    });
    expect(result.json.error?.code).toBe("activation_needs_person");
    expect(await stored()).toBe(0);
  });

  test("a worker with no terminal leaves every unresolved run identity_missing", async () => {
    await seatDispatch(db.db, {
      runId: "run-1",
      dispatchId: "d-2",
      seat: "dev",
      terminal: null,
    });
    const result = runCli(activate);
    expect(result.status).toBe(3);
    expect(result.json.error?.code).toBe("identity_missing");
    expect(result.json.error?.nextSteps.join(" ")).toContain("d-2");
    expect(await stored()).toBe(0);
  });

  test("a launch in flight leaves every unresolved run identity_missing", async () => {
    await openLaunch(db.db, "launch-in-flight");
    const result = runCli(activate, { ORCA_TERMINAL_HANDLE: "term-new" });
    expect(result.json.error?.code).toBe("identity_missing");
    expect(result.json.error?.nextSteps.join(" ")).toContain(
      "launch-in-flight",
    );
    expect(await stored()).toBe(0);
  });

  test("a recorded terminal on another host does not make this run a Seat", async () => {
    await seatRun(db.db, "run-far", { host: "elsewhere" });
    await seatDispatch(db.db, {
      runId: "run-far",
      dispatchId: "d-far",
      seat: "dev",
      terminal: "term-shared",
    });
    const result = runCli(activate, { ORCA_TERMINAL_HANDLE: "term-shared" });
    expect(result.status).toBe(0);
    expect(result.json.result?.["activation"]).not.toBeNull();
  });

  test("POD_SEAT is refused activation_needs_person", async () => {
    const result = runCli(activate, { POD_SEAT: "dev" });
    expect(result.json.error?.code).toBe("activation_needs_person");
    expect(await stored()).toBe(0);
  });

  test("once the workers settle, the operator's own shell activates as the person", async () => {
    await seatDispatch(db.db, {
      runId: "run-1",
      dispatchId: "d-3",
      seat: "dev",
      terminal: null,
      settled: true,
    });
    const result = runCli(activate, { ORCA_TERMINAL_HANDLE: "term-operator" });
    expect(result.status).toBe(0);
    const [row] = await db.sql<
      { activated_by: string }[]
    >`select activated_by from config.activation where name = 'bypass'`;
    expect(row?.activated_by).toBe(`person:${operator}`);
  });
});
