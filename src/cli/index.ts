import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { PodError, usageError } from "./errors.ts";
import { usageFor, verbs } from "./verbs.ts";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error: PodError): void {
  write({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      nextSteps: error.nextSteps,
    },
  });
  process.exitCode = error.exit;
}

function help(rows: readonly (typeof verbs)[number][]): void {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : 1));
  write({
    ok: true,
    result: {
      verbs: sorted.map((verb) => ({
        name: verb.name,
        sideEffect: verb.sideEffect,
        cancelBy: verb.cancelBy,
        evidenceRequired: verb.evidenceRequired,
      })),
    },
    meta: { pod: pkg.version },
  });
}

function verbFrom(
  positionals: string[],
): { verb: (typeof verbs)[number]; args: string[] } | undefined {
  const two = verbs.find(
    (item) => item.name === positionals.slice(0, 2).join(" "),
  );
  if (two !== undefined) return { verb: two, args: positionals.slice(2) };
  const one = positionals[0];
  const oneVerb =
    one === undefined ? undefined : verbs.find((item) => item.name === one);
  if (oneVerb !== undefined)
    return { verb: oneVerb, args: positionals.slice(1) };
  return undefined;
}

const options = {
  help: { type: "boolean" },
  activate: { type: "boolean" },
  accept: { type: "boolean" },
  reject: { type: "boolean" },
  scope: { type: "string" },
  "expected-revision": { type: "string" },
  "op-key": { type: "string" },
  reason: { type: "string" },
  unset: { type: "string", multiple: true },
  from: { type: "string" },
  ticket: { type: "string" },
  string: { type: "boolean" },
  out: { type: "string" },
  all: { type: "boolean" },
  prune: { type: "boolean" },
  html: { type: "string" },
  process: { type: "string" },
  size: { type: "string" },
  stage: { type: "string" },
  task: { type: "string" },
  seat: { type: "string" },
  generation: { type: "string" },
  run: { type: "string" },
  day: { type: "string" },
  date: { type: "string" },
  wait: { type: "boolean" },
  interval: { type: "string" },
  timeout: { type: "string" },
  resume: { type: "boolean" },
  observe: { type: "boolean" },
  dispatch: { type: "string" },
  retain: { type: "boolean" },
  end: { type: "boolean" },
  "keep-files-reviewed": { type: "boolean" },
  area: { type: "string" },
  kind: { type: "string" },
  reporter: { type: "string" },
  expected: { type: "string" },
  "repeat-of": { type: "string" },
  project: { type: "string" },
  story: { type: "string" },
  adoption: { type: "string" },
  text: { type: "string" },
  category: { type: "string" },
  effect: { type: "string" },
  decision: { type: "string" },
  note: { type: "string" },
  supersedes: { type: "string" },
  page: { type: "string" },
  heading: { type: "string" },
  json: { type: "boolean" },
  stdin: { type: "boolean" },
  host: { type: "string" },
  publish: { type: "boolean" },
  until: { type: "string" },
  trigger: { type: "string", multiple: true },
  section: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  agenda: { type: "string" },
  slot: { type: "string" },
  points: { type: "string" },
  repo: { type: "string" },
  at: { type: "string" },
  function: { type: "string", multiple: true },
  asserts: { type: "string", multiple: true },
  check: { type: "string", multiple: true },
  files: { type: "string", multiple: true },
} satisfies ParseArgsOptionsConfig;

function parse() {
  const args = process.argv.slice(2);
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch {
    const { positionals } = parseArgs({
      args,
      options,
      strict: false,
      allowPositionals: true,
    });
    const found = verbFrom(positionals);
    throw found === undefined ? usageError("usage") : usageFor(found.verb);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parse();
  const { help: wantsHelp, ...flags } = values;
  if (wantsHelp === true) {
    if (Object.keys(flags).length > 0) throw usageError("usage");
    if (positionals.length === 0) {
      help(verbs);
      return;
    }
    const named = verbFrom(positionals);
    if (named === undefined || named.args.length > 0) throw usageError("usage");
    help([named.verb]);
    return;
  }
  const found = verbFrom(positionals);
  if (found === undefined) throw usageError("usage");
  const { verb, args } = found;
  const input = verb.input.safeParse({ args, ...flags });
  if (!input.success) throw usageFor(verb);
  const result = verb.output.parse(await verb.handler(input.data, {}));
  if (verb.render !== undefined && flags.json !== true) {
    process.stdout.write(`${verb.render(result)}\n`);
    return;
  }
  write({
    ok: true,
    result,
    meta: { pod: pkg.version, ...verb.meta?.(result) },
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof PodError) fail(error);
  else {
    const message = error instanceof Error ? error.message : String(error);
    fail(new PodError("failed", 1, message, []));
  }
}
