import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { schemaError, usageError } from "./errors.ts";
import { issuesOf, parseYaml } from "./yaml-file.ts";

const HostProfile = z.looseObject({
  host_id: z.string().min(1).default("local"),
  db: z
    .looseObject({ url_env: z.string().min(1).default("POD_DB_URL") })
    .prefault({}),
  capacity: z.int().positive().default(2),
  tracker: z
    .looseObject({
      kind: z.string().min(1).default("linear"),
      token_env: z.string().min(1).default("POD_TRACKER_TOKEN"),
      estimate_scale: z.string().min(1).default("fibonacci"),
    })
    .prefault({}),
});

export interface HostSettings {
  hostId: string;
  urlEnv: string;
  capacity: number;
  trackerKind: string;
  trackerTokenEnv: string;
  estimateScale: string;
}

export function podHome(): string {
  const home = process.env["POD_HOME"];
  return home === undefined || home === "" ? join(homedir(), ".pod") : home;
}

function profilePath(): string {
  return join(podHome(), "host.yaml");
}

function readProfileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readHostProfile(): HostSettings {
  const path = profilePath();
  const text = readProfileText(path);
  const parsed = HostProfile.safeParse(
    text === null ? {} : (parseYaml(text, path) ?? {}),
  );
  if (!parsed.success)
    throw schemaError(
      `${path} fails the host profile schema`,
      issuesOf(parsed.error),
    );
  return {
    hostId: parsed.data.host_id,
    urlEnv: parsed.data.db.url_env,
    capacity: parsed.data.capacity,
    trackerKind: parsed.data.tracker.kind,
    trackerTokenEnv: parsed.data.tracker.token_env,
    estimateScale: parsed.data.tracker.estimate_scale,
  };
}

export function databaseUrl(settings: HostSettings): string {
  const url = process.env[settings.urlEnv];
  if (url === undefined || url === "")
    throw usageError(`${settings.urlEnv} is not set`, [
      `set ${settings.urlEnv} to the database URL`,
    ]);
  return url;
}
