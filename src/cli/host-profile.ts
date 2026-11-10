import { readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { schemaError, usageError } from "./errors.ts";
import { issuesOf, parseYaml } from "./yaml-file.ts";

const HostProfile = z.looseObject({
  host_id: z.string().min(1).default("local"),
  db: z
    .looseObject({ url_env: z.string().min(1).default("POD_DB_URL") })
    .prefault({}),
  credentials_file: z.string().min(1).optional(),
  capacity: z.int().positive().default(2),
  operator: z.string().min(1).optional(),
  tracker: z
    .looseObject({
      kind: z.string().min(1).default("linear"),
      token_env: z.string().min(1).default("POD_TRACKER_TOKEN"),
      estimate_scale: z.string().min(1).default("fibonacci"),
    })
    .prefault({}),
  docs: z
    .looseObject({
      kind: z.string().min(1).default("notion"),
      token_env: z.string().min(1).default("POD_DOCS_TOKEN"),
    })
    .prefault({}),
});

export interface HostSettings {
  hostId: string;
  urlEnv: string;
  credentialsFile: string;
  capacity: number;
  trackerKind: string;
  trackerTokenEnv: string;
  estimateScale: string;
  docsKind: string;
  docsTokenEnv: string;
  operator: string | null;
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
    credentialsFile: resolve(
      podHome(),
      parsed.data.credentials_file ?? "credentials",
    ),
    capacity: parsed.data.capacity,
    trackerKind: parsed.data.tracker.kind,
    trackerTokenEnv: parsed.data.tracker.token_env,
    estimateScale: parsed.data.tracker.estimate_scale,
    docsKind: parsed.data.docs.kind,
    docsTokenEnv: parsed.data.docs.token_env,
    operator: parsed.data.operator ?? null,
  };
}

export interface Credentials {
  source: "file" | "env";
  get(name: string): string | null;
  values(): string[];
  warnings(): string[];
}

function credentialNames(settings: HostSettings): string[] {
  return [settings.urlEnv, settings.trackerTokenEnv, settings.docsTokenEnv];
}

function fromEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function fileStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw usageError(`${path} cannot be read`, [`chmod 600 ${path}`]);
  }
}

function parseCredentials(path: string, text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const name = at === -1 ? "" : line.slice(0, at).trim();
    if (name === "")
      throw usageError(`${path} line ${index + 1} is not NAME=value`, [
        `fix line ${index + 1} of ${path} to read NAME=value`,
      ]);
    const value = line.slice(at + 1).trim();
    if (value === "") values.delete(name);
    else values.set(name, value);
  }
  return values;
}

function readCredentialsFile(path: string): Map<string, string> | null {
  const stat = fileStat(path);
  if (stat === null) return null;
  if (!stat.isFile())
    throw usageError(`${path} is not a file`, [
      `replace ${path} with a NAME=value file`,
    ]);
  if ((stat.mode & 0o077) !== 0)
    throw usageError(`${path} is open to group or other`, [
      `chmod 600 ${path}`,
    ]);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw usageError(`${path} cannot be read`, [`chmod 600 ${path}`]);
  }
  return parseCredentials(path, text);
}

const warnedFromEnv = new Set<string>();

export function readCredentials(settings: HostSettings): Credentials {
  const path = settings.credentialsFile;
  const names = credentialNames(settings);
  const file = readCredentialsFile(path);
  if (file !== null)
    return {
      source: "file",
      get: (name) => file.get(name) ?? null,
      values: () => [...file.values()],
      warnings: () =>
        [...new Set(names)]
          .filter((name) => fromEnv(name) !== null)
          .map(
            (name) =>
              `${name} is exported in this session; Seats inherit it. Remove it from the session environment`,
          ),
    };
  return {
    source: "env",
    get(name) {
      const value = fromEnv(name);
      const key = `${path}\0${name}`;
      if (value !== null && !warnedFromEnv.has(key)) {
        warnedFromEnv.add(key);
        process.stderr.write(
          `warning: ${path} is absent; ${name} is read from the session environment, which Seats inherit\n`,
        );
      }
      return value;
    },
    values: () =>
      names.map(fromEnv).filter((value): value is string => value !== null),
    warnings: () => [],
  };
}

export function credentialStep(
  settings: HostSettings,
  name: string,
  what: string,
): string {
  return readCredentials(settings).source === "file"
    ? `add ${name}=<the ${what}> to ${settings.credentialsFile}`
    : `set ${name} to the ${what}`;
}

export function databaseUrl(settings: HostSettings): string {
  const credentials = readCredentials(settings);
  const url = credentials.get(settings.urlEnv);
  if (url !== null) return url;
  const where =
    credentials.source === "file" ? ` in ${settings.credentialsFile}` : "";
  throw usageError(`${settings.urlEnv} is not set${where}`, [
    credentialStep(settings, settings.urlEnv, "database URL"),
  ]);
}
