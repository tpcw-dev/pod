import type { ZodType } from "zod";
import {
  LooseResult,
  RequestShowResult,
  RunCreateResult,
  TaskCreateResult,
  WorkerStartResult,
  type OrcaPort,
  type Receipt,
} from "../../core/ports/orca.ts";
import { argvFor } from "./argv.ts";

export type Call = <T>(
  argv: string[],
  schema: ZodType<T>,
) => Promise<Receipt<T>>;

export function methods(call: Call): Omit<OrcaPort, "version"> {
  return {
    runCreate: (req) => call(argvFor.runCreate(req), RunCreateResult),
    runUse: (req) => call(argvFor.runUse(req), LooseResult),
    taskCreate: (req) => call(argvFor.taskCreate(req), TaskCreateResult),
    workerStart: (req) => call(argvFor.workerStart(req), WorkerStartResult),
    workerStop: (req) => call(argvFor.workerStop(req), LooseResult),
    workerRelease: (req) => call(argvFor.workerRelease(req), LooseResult),
    check: (req) => call(argvFor.check(req), LooseResult),
    send: (req) => call(argvFor.send(req), LooseResult),
    requestShow: (req) => call(argvFor.requestShow(req), RequestShowResult),
    workerList: (req) => call(argvFor.workerList(req), LooseResult),
  };
}
