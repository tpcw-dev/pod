import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

const startTimeoutMs = 60_000;
const exitTimeoutMs = 15_000;

// Vitest 5.0.5 crashes printing a global setup error that has a stack frame,
// and the message is lost.
function setupError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // the group has already exited
  }
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), ms).unref(),
  );
}

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const given = process.env["POD_DB_TEST_URL"];
  if (given !== undefined && given !== "") {
    console.log("test database: using POD_DB_TEST_URL");
    project.provide("dbUrl", given);
    return undefined;
  }
  if (process.env["POD_DB_REQUIRED"] === "1")
    throw setupError("POD_DB_REQUIRED=1 and POD_DB_TEST_URL is unset");

  // embedded-postgres registers an exit hook that forces exit code 0, so it
  // runs in a child process and never loads into vitest's own process.
  const child = spawn("node_modules/.bin/tsx", ["test/db/embedded-server.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let serverLog = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (serverLog += chunk));
  const exited = new Promise<"exited">((resolve) =>
    child.once("exit", () => resolve("exited")),
  );
  const ready = new Promise<string>((resolve) =>
    createInterface({ input: child.stdout }).once("line", resolve),
  );

  const first = await Promise.race([ready, exited, timeout(startTimeoutMs)]);
  if (first === "exited" || first === "timeout") {
    killGroup(child);
    const reason = first === "timeout" ? " (timed out after 60 s)" : "";
    throw setupError(
      `embedded Postgres failed to start${reason}; server log:\n${serverLog}`,
    );
  }

  const { url } = JSON.parse(first) as { url: string };
  console.log(`test database: embedded Postgres at ${new URL(url).host}`);
  project.provide("dbUrl", url);

  return async () => {
    child.stdin.end();
    if ((await Promise.race([exited, timeout(exitTimeoutMs)])) === "timeout")
      killGroup(child);
  };
}
