import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = "127.0.0.1";
const stopTimeoutMs = 10_000;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, host, resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string")
    throw new Error("could not read a free port");
  return address.port;
}

const port = await freePort();
const databaseDir = await mkdtemp(join(tmpdir(), "pod-pg-"));
const log: string[] = [];
const server = new EmbeddedPostgres({
  databaseDir,
  port,
  user: "pod",
  password: "pod",
  persistent: false,
  postgresFlags: ["-c", `listen_addresses=${host}`],
  onLog: (message) => log.push(String(message)),
  onError: (message) => log.push(String(message)),
});

async function stop(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    server.stop().catch(() => undefined),
    new Promise((resolve) => (timer = setTimeout(resolve, stopTimeoutMs))),
  ]);
  clearTimeout(timer);
  await rm(databaseDir, { recursive: true, force: true });
}

async function fail(error: unknown): Promise<never> {
  await rm(databaseDir, { recursive: true, force: true });
  if (error !== undefined) log.push(String(error));
  process.stderr.write(log.join("\n"));
  process.exit(1);
}

// stop() after a failed initialise() or start() never resolves: it waits for
// an exit event the dead postgres process has already emitted.
try {
  await server.initialise();
  await server.start();
} catch (error) {
  await fail(error);
}

try {
  await server.createDatabase("pod");
} catch (error) {
  await stop();
  await fail(error);
}

process.stdout.write(
  `${JSON.stringify({ url: `postgres://pod:pod@${host}:${port}/pod` })}\n`,
);
process.stdin.on("end", () => {
  void stop().then(() => process.exit(0));
});
process.stdin.resume();
