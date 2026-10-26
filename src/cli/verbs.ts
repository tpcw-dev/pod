import type { ZodType } from "zod";
import {
  ConfigApplyInput,
  ConfigApplyOutput,
  ConfigExportInput,
  ConfigExportOutput,
  configApply,
  configExport,
} from "./config-verbs.ts";
import { BriefInput, BriefOutput, brief } from "./brief.ts";
import { DbMigrateInput, DbMigrateOutput, dbMigrate } from "./db-verbs.ts";

export type VerbContext = Record<string, never>;

export interface VerbRow<I, O> {
  name: string;
  input: ZodType<I>;
  output: ZodType<O>;
  handler: (input: I, ctx: VerbContext) => Promise<O>;
  sideEffect: "none" | "config" | "ledger" | "orca" | "tracker";
  cancelBy: "operator" | "coordinator" | "nobody";
  evidenceRequired: readonly string[];
}

function row<I, O>(verb: VerbRow<I, O>): VerbRow<unknown, unknown> {
  return {
    ...verb,
    handler: (input, ctx) => verb.handler(verb.input.parse(input), ctx),
  };
}

export const verbs: readonly VerbRow<unknown, unknown>[] = [
  row({
    name: "brief",
    input: BriefInput,
    output: BriefOutput,
    handler: brief,
    sideEffect: "none",
    cancelBy: "nobody",
    evidenceRequired: [
      "a Story whose external_id matches story:<id> when that argument is set",
    ],
  }),
  row({
    name: "config apply",
    input: ConfigApplyInput,
    output: ConfigApplyOutput,
    handler: configApply,
    sideEffect: "config",
    cancelBy: "nobody",
    evidenceRequired: [
      "a file that passes its schema, every Role filled and every gate id present when the kind is process, and `expected_revision` equal to the active Revision when `--activate` is set",
    ],
  }),
  row({
    name: "config export",
    input: ConfigExportInput,
    output: ConfigExportOutput,
    handler: configExport,
    sideEffect: "none",
    cancelBy: "nobody",
    evidenceRequired: ["a Revision named by kind.name@rev"],
  }),
  row({
    name: "db migrate",
    input: DbMigrateInput,
    output: DbMigrateOutput,
    handler: dbMigrate,
    sideEffect: "config",
    cancelBy: "nobody",
    evidenceRequired: [
      "a reachable database and a `db/migrations/` journal that matches the applied-migrations table",
    ],
  }),
];
