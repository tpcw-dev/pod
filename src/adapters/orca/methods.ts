import type { ZodType } from "zod";
import {
  CheckResult,
  LooseResult,
  RequestShowResult,
  RunCreateResult,
  TaskCreateResult,
  WorkerListResult,
  WorkerReleaseResult,
  WorkerStartResult,
  WorkerStopResult,
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
    workerStop: (req) => call(argvFor.workerStop(req), WorkerStopResult),
    workerRelease: (req) =>
      call(argvFor.workerRelease(req), WorkerReleaseResult),
    check: (req) => call(argvFor.check(req), CheckResult),
    send: (req) => call(argvFor.send(req), LooseResult),
    requestShow: (req) => call(argvFor.requestShow(req), RequestShowResult),
    workerList: (req) => call(argvFor.workerList(req), WorkerListResult),
  };
}
