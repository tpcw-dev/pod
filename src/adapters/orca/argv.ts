import type {
  CheckRequest,
  RequestShowRequest,
  RunCreateRequest,
  RunUseRequest,
  SendRequest,
  TaskCreateRequest,
  WorkerListRequest,
  WorkerReleaseRequest,
  WorkerStartRequest,
  WorkerStopRequest,
} from "../../core/ports/orca.ts";

type Flag = readonly [
  string,
  string | readonly string[] | boolean | number | undefined,
];

function flags(verb: string, pairs: readonly Flag[]): string[] {
  const argv = ["orchestration", verb];
  for (const [name, value] of pairs) {
    if (value === undefined || value === false) continue;
    if (value === true) argv.push(name);
    else if (typeof value === "string") argv.push(name, value);
    else if (typeof value === "number") argv.push(name, String(value));
    else argv.push(name, JSON.stringify(value));
  }
  argv.push("--json");
  return argv;
}

export const freeTextFlags: readonly string[] = [
  "--objective",
  "--spec",
  "--task-title",
  "--subject",
  "--body",
];

export const argvFor = {
  runCreate: (req: RunCreateRequest) =>
    flags("run-create", [
      ["--objective", req.objective],
      ["--retry-request", req.retryRequest],
    ]),
  runUse: (req: RunUseRequest) =>
    flags("run-use", [
      ["--id", req.run],
      ["--retry-request", req.retryRequest],
    ]),
  taskCreate: (req: TaskCreateRequest) =>
    flags("task-create", [
      ["--spec", req.spec],
      ["--run", req.run],
      ["--deps", req.deps],
      ["--task-title", req.taskTitle],
      ["--retry-request", req.retryRequest],
    ]),
  workerStart: (req: WorkerStartRequest) =>
    flags("worker-start", [
      ["--task", req.task],
      ["--spec", req.spec],
      ["--run", req.run],
      ["--agent", req.agent],
      ["--model", req.model],
      ["--effort", req.effort],
      ["--worktree", req.worktree],
      ["--deps", req.deps],
      ["--retry-of", req.retryOf],
      ["--retry-request", req.retryRequest],
    ]),
  workerStop: (req: WorkerStopRequest) =>
    flags("worker-stop", [
      ["--dispatch", req.dispatch],
      ["--retry-request", req.retryRequest],
    ]),
  workerRelease: (req: WorkerReleaseRequest) =>
    flags("worker-release", [
      ["--dispatch", req.dispatch],
      ["--retry-request", req.retryRequest],
    ]),
  check: (req: CheckRequest) =>
    flags("check", [
      ["--run", req.run],
      ["--ack", req.ack],
      ["--wait", req.wait],
      ["--timeout-ms", req.timeoutMs],
    ]),
  send: (req: SendRequest) =>
    flags("send", [
      ["--to", req.to],
      ["--subject", req.subject],
      ["--body", req.body],
      ["--run", req.run],
      ["--retry-request", req.retryRequest],
    ]),
  requestShow: (req: RequestShowRequest) =>
    flags("request-show", [["--request", req.request]]),
  workerList: (req: WorkerListRequest) =>
    flags("worker-list", [
      ["--run", req.run],
      ["--terminal-state", req.terminalState],
      ["--cursor", req.cursor],
      ["--limit", req.limit],
    ]),
};

export function matchArgv(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === undefined) continue;
    if (freeTextFlags.includes(part)) {
      i += 1;
      continue;
    }
    kept.push(part);
  }
  return kept;
}
