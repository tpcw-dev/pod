import { z, type ZodType } from "zod";

export const linearUrl = "https://api.linear.app/graphql";
export const requestTimeoutMs = 10_000;

const issueFields =
  "id identifier title description estimate state { id name type } labels { nodes { name } } team { id key states { nodes { id name type } } }";
const commentFields = "id body editedAt user { id }";

export const operations = {
  Story: `query Story($id: String!) { issue(id: $id) { ${issueFields} } }`,
  StoryComments: `query StoryComments($id: String!, $after: String) { issue(id: $id) { comments(first: 50, after: $after, orderBy: createdAt) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } }`,
  Comment: `query Comment($id: String!) { comment(id: $id) { ${commentFields} issue { identifier } } }`,
  PostComment: `mutation PostComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { ${commentFields} } } }`,
  Workspace: "query Workspace { organization { urlKey } }",
  SetStatus: `mutation SetStatus($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${issueFields} } } }`,
} as const;
export type Operation = keyof typeof operations;

export interface GraphqlRequest {
  operation: Operation;
  variables: Record<string, unknown>;
}

export interface HttpReply {
  status: number | null;
  body: string | null;
  error: string | null;
  requestId: string | null;
}

export type Transport = (
  request: GraphqlRequest,
  options: { drop: boolean },
) => Promise<HttpReply>;

export function fetchTransport(
  token: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = requestTimeoutMs,
): Transport {
  return async (request, options) => {
    let response: Response;
    let body: string;
    try {
      response = await fetchFn(linearUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({
          query: operations[request.operation],
          variables: request.variables,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        status: null,
        body: null,
        error: name === "TimeoutError" ? "timeout" : "network",
        requestId: null,
      };
    }
    if (options.drop)
      return { status: null, body: null, error: "dropped", requestId: null };
    return {
      status: response.status,
      body,
      error: null,
      requestId: response.headers.get("x-request-id"),
    };
  };
}

export interface Decoded<T> {
  ok: boolean;
  result: T | null;
  raw: unknown;
  error: string | null;
}

const Envelope = z.looseObject({ data: z.record(z.string(), z.unknown()) });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorsOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || !("errors" in raw)) return [];
  const { errors } = raw;
  if (!Array.isArray(errors)) return [];
  return errors.map((item: unknown) =>
    item !== null &&
    typeof item === "object" &&
    "message" in item &&
    typeof item.message === "string"
      ? item.message
      : "graphql_error",
  );
}

export function decode<T>(
  reply: HttpReply,
  pick: (data: Record<string, unknown>) => unknown,
  schema: ZodType<T>,
): Decoded<T> {
  if (reply.error !== null)
    return { ok: false, result: null, raw: null, error: reply.error };
  const raw = reply.body === null ? null : parseJson(reply.body);
  const errors = errorsOf(raw);
  if (errors.some((message) => message.startsWith("Entity not found")))
    return { ok: true, result: null, raw, error: null };
  if (reply.status === null || reply.status < 200 || reply.status >= 300)
    return {
      ok: false,
      result: null,
      raw,
      error: `http_${reply.status ?? 0}`,
    };
  const [first] = errors;
  if (first !== undefined)
    return { ok: false, result: null, raw, error: first };
  const data = Envelope.safeParse(raw);
  if (!data.success) return { ok: false, result: null, raw, error: "unparsed" };
  const parsed = schema.safeParse(pick(data.data.data));
  return parsed.success
    ? { ok: true, result: parsed.data, raw, error: null }
    : { ok: false, result: null, raw, error: "unparsed" };
}
