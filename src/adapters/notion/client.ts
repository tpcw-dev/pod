import type { ZodType } from "zod";
import type { DocsRequest } from "../../core/ports/docs.ts";

export const notionOrigin = "https://api.notion.com";
export const notionUrl = `${notionOrigin}/v1`;
export const notionVersion = "2022-06-28";
export const requestTimeoutMs = 10_000;

export interface HttpReply {
  status: number | null;
  body: string | null;
  error: string | null;
  requestId: string | null;
}

export type Transport = (request: DocsRequest) => Promise<HttpReply>;

export function fetchTransport(
  token: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = requestTimeoutMs,
): Transport {
  return async (request) => {
    const url = new URL(`${notionOrigin}${request.path}`);
    for (const [key, value] of Object.entries(request.query))
      url.searchParams.set(key, value);
    let response: Response;
    let body: string;
    try {
      response = await fetchFn(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": notionVersion,
        },
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
    return {
      status: response.status,
      body,
      error: null,
      requestId: response.headers.get("x-notion-request-id"),
    };
  };
}

export interface Decoded<T> {
  ok: boolean;
  result: T | null;
  raw: unknown;
  error: string | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function codeOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || !("code" in raw)) return null;
  return typeof raw.code === "string" && raw.code !== "" ? raw.code : null;
}

export function decode<T>(reply: HttpReply, schema: ZodType<T>): Decoded<T> {
  if (reply.error !== null)
    return { ok: false, result: null, raw: null, error: reply.error };
  const raw = reply.body === null ? null : parseJson(reply.body);
  if (reply.status === null || reply.status < 200 || reply.status >= 300)
    return {
      ok: false,
      result: null,
      raw,
      error: codeOf(raw) ?? `http_${reply.status ?? 0}`,
    };
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, result: parsed.data, raw, error: null }
    : { ok: false, result: null, raw, error: "unparsed" };
}
