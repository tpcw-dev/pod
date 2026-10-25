import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { verbs } from "./verbs.ts";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(): never {
  write({
    ok: false,
    error: {
      code: "usage",
      message: "usage",
      nextSteps: ["pod --help"],
    },
  });
  return process.exit(2);
}

const parsed = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: { help: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    return usage();
  }
})();

if (parsed.values.help !== true) usage();

write({
  ok: true,
  result: {
    verbs: verbs.map((verb) => ({
      name: verb.name,
      sideEffect: verb.sideEffect,
      cancelBy: verb.cancelBy,
      evidenceRequired: verb.evidenceRequired,
    })),
  },
  meta: { pod: pkg.version },
});
