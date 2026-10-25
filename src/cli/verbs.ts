import type { ZodType } from "zod";

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

export const verbs: readonly VerbRow<unknown, unknown>[] = [];
