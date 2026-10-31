import { mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { z } from "zod";
import { decode, fetchTransport } from "../adapters/notion/client.ts";
import { makeRealDocs } from "../adapters/notion/real.ts";
import { makeReplayDocs } from "../adapters/notion/replay.ts";
import { makeDocsScrubber } from "../adapters/notion/scrub.ts";
import type { FixtureRefused } from "../core/domain/scrub.ts";
import type { DocsPort, DocsReceiptSink } from "../core/ports/docs.ts";
import { usageError } from "./errors.ts";
import type { HostSettings } from "./host-profile.ts";

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function denylist(): string[] {
  const path = env("POD_SCRUB_DENYLIST");
  if (path === null)
    throw usageError("POD_DOCS_RECORD needs POD_SCRUB_DENYLIST", [
      "set POD_SCRUB_DENYLIST to the denylist file outside the repo",
    ]);
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    throw usageError("POD_SCRUB_DENYLIST names a file that cannot be read", [
      "set POD_SCRUB_DENYLIST to a readable denylist file",
    ]);
  }
}

export interface DocsWiring {
  port: DocsPort;
  recordRefusals(): readonly FixtureRefused[];
}

const Me = z.looseObject({
  bot: z.looseObject({ workspace_name: z.string() }),
});

async function workspaceName(token: string): Promise<string[]> {
  const reply = await fetchTransport(token)({
    method: "GET",
    path: "/v1/users/me",
    query: {},
  });
  const decoded = decode(reply, Me);
  if (decoded.result === null)
    throw usageError("POD_DOCS_RECORD could not read the workspace name", [
      `docs error ${decoded.error ?? "none"}`,
    ]);
  return [decoded.result.bot.workspace_name];
}

export async function docsFor(
  sink: DocsReceiptSink,
  host: HostSettings,
): Promise<DocsWiring | null> {
  if (host.docsKind !== "notion")
    throw usageError(`docs.kind ${host.docsKind} has no adapter`, [
      "set docs.kind to notion in the host profile",
    ]);
  const fixtures = env("POD_DOCS_FIXTURES");
  if (fixtures !== null)
    return {
      port: makeReplayDocs({ dir: fixtures, sink }),
      recordRefusals: () => [],
    };
  const token = env(host.docsTokenEnv);
  const dir = env("POD_DOCS_RECORD");
  if (dir === null) {
    if (token === null) return null;
    return {
      port: makeRealDocs({ sink, transport: fetchTransport(token) }),
      recordRefusals: () => [],
    };
  }
  const terms = denylist();
  if (token === null)
    throw usageError(`POD_DOCS_RECORD needs ${host.docsTokenEnv}`, [
      `set ${host.docsTokenEnv} to the docs token`,
    ]);
  mkdirSync(dir, { recursive: true });
  const port = makeRealDocs({
    sink,
    transport: fetchTransport(token),
    record: {
      dir,
      scrubber: makeDocsScrubber({
        hosts: [hostname(), host.hostId],
        users: [userInfo().username],
        roots: [process.cwd()],
        workspace: await workspaceName(token),
        denylist: terms,
      }),
    },
  });
  return { port, recordRefusals: () => port.recordRefusals() };
}
