import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { PodError, usageError } from "./errors.ts";
import { verbs } from "./verbs.ts";

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

function help(): void {
  const sorted = [...verbs].sort((a, b) => (a.name < b.name ? -1 : 1));
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

function parse() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: "boolean" },
        activate: { type: "boolean" },
        scope: { type: "string" },
        "expected-revision": { type: "string" },
        "op-key": { type: "string" },
        reason: { type: "string" },
        out: { type: "string" },
        html: { type: "string" },
        process: { type: "string" },
        size: { type: "string" },
        stage: { type: "string" },
        task: { type: "string" },
        seat: { type: "string" },
        generation: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    throw usageError("usage");
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parse();
  const { help: wantsHelp, ...flags } = values;
  if (wantsHelp === true) {
    if (positionals.length > 0 || Object.keys(flags).length > 0)
      throw usageError("usage");
    help();
    return;
  }
  const twoWord = positionals.slice(0, 2).join(" ");
  let verb = verbs.find((item) => item.name === twoWord);
  let args = positionals.slice(2);
  if (verb === undefined) {
    const one = positionals[0];
    const oneVerb =
      one === undefined ? undefined : verbs.find((item) => item.name === one);
    if (oneVerb !== undefined) {
      verb = oneVerb;
      args = positionals.slice(1);
    }
  }
  if (verb === undefined) throw usageError("usage");
  const input = verb.input.safeParse({ args, ...flags });
  if (!input.success) throw usageError(`usage: ${verb.name}`, ["pod --help"]);
  const result = verb.output.parse(await verb.handler(input.data, {}));
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
