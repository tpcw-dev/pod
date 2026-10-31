import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
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
