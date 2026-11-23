import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { PodError, usageError } from "./errors.ts";
import { options } from "./options.ts";
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
