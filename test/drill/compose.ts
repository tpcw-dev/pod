import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const storyId = "TRK-1";
export const candidate = "a".repeat(40);
export const staleHead = "bbbbbbb";
export const reviewerSeat = "rec-rev";
export const developerSeat = "rec-dev";
export const oldHandle = "term_138f909e-aaa2-496c-97ea-796ec49e4fb8";
export const newHandle = "term_0db4b199-e75e-4484-81b4-7487524ec679";
export const verdictBody = `${reviewerSeat}: review PASS\nHead: ${candidate}`;
export const orcaDir = "fixtures/orca/integrated-drill";
export const trackerDir = "fixtures/tracker/integrated-drill";

const runId = "run_93ad51f835ba";
const implementTask = "task_bb5a6dfde80b";
const reviewTask = "task_2b3ff5a78b43";
const otherRuns = ["run_2504596fe174", "run_4b2a6c32867e"];
const droppedBody = "pod fixture: tracker-dropped-reply";

const OrcaFixture = z.looseObject({
  verb: z.string(),
  match: z.looseObject({ argv: z.array(z.string()) }),
  exitCode: z.number(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  orcaVersion: z.string(),
  recordedAt: z.string(),
});
type OrcaFixture = z.infer<typeof OrcaFixture>;

const TrackerFixture = z.looseObject({
  method: z.string(),
  match: z.looseObject({
    operation: z.string(),
    variables: z.record(z.string(), z.unknown()),
  }),
  status: z.number().nullable(),
  body: z.string().nullable(),
  error: z.string().nullable(),
  recordedAt: z.string(),
});
type TrackerFixture = z.infer<typeof TrackerFixture>;

const Envelope = z.looseObject({
  result: z.looseObject({
    deliveryId: z.string().nullable().optional(),
    messages: z.array(z.unknown()).optional(),
    workers: z.array(z.unknown()).optional(),
    page: z.looseObject({ total: z.number().optional() }).optional(),
  }),
});

const Message = z.looseObject({ payload: z.string() });

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function taskId(n: number): string {
  return `task_${sha256(`integrated-drill task ${n}`).slice(0, 12)}`;
}

function loadOrca(dir: string): OrcaFixture[] {
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.json$/.test(name))
    .sort()
    .map((name) =>
      OrcaFixture.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))),
    );
}

function loadTracker(dir: string): TrackerFixture[] {
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.json$/.test(name))
    .sort()
    .map((name) =>
      TrackerFixture.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))),
    );
}

function one(entries: readonly OrcaFixture[], verb: string): OrcaFixture {
  const found = entries.find((entry) => entry.verb === verb);
  if (found === undefined) throw new Error(`no ${verb} fixture`);
  return structuredClone(found);
}

function checks(entries: readonly OrcaFixture[]): {
  open: OrcaFixture;
  ack: OrcaFixture;
} {
  const rows = entries.filter((entry) => entry.verb === "check");
  const open = rows.find((entry) => !entry.match.argv.includes("--ack"));
  const ack = rows.find((entry) => entry.match.argv.includes("--ack"));
  if (open === undefined || ack === undefined)
    throw new Error("a check pair is missing");
  return { open: structuredClone(open), ack: structuredClone(ack) };
}

function replaceText(
  value: OrcaFixture,
  from: string,
  to: string,
): OrcaFixture {
  return OrcaFixture.parse(
    JSON.parse(JSON.stringify(value).replaceAll(from, to)),
  );
}

function quietCheck(entry: OrcaFixture): OrcaFixture {
  const next = structuredClone(entry);
  const stdout = Envelope.parse(JSON.parse(next.stdout));
  stdout.result.messages = [];
  stdout.result.deliveryId = null;
  next.stdout = JSON.stringify(stdout);
  const argv: string[] = [];
  for (let i = 0; i < next.match.argv.length; i += 1) {
    const flag = next.match.argv[i];
    if (flag === "--ack") {
      i += 1;
      continue;
    }
    if (flag !== undefined) argv.push(flag);
  }
  next.match.argv = argv;
  return next;
}

function emptyWorkers(entry: OrcaFixture): OrcaFixture {
  const next = structuredClone(entry);
  const stdout = Envelope.parse(JSON.parse(next.stdout));
  stdout.result.workers = [];
  if (stdout.result.page !== undefined) stdout.result.page.total = 0;
  next.stdout = JSON.stringify(stdout);
  return next;
}

function withHead(entry: OrcaFixture): OrcaFixture {
  const next = structuredClone(entry);
  const stdout = Envelope.parse(JSON.parse(next.stdout));
  const messages = stdout.result.messages ?? [];
  const message = Message.parse(messages[0]);
  const payload = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(message.payload));
  payload["head"] = candidate;
  payload["taskId"] = reviewTask;
  message.payload = JSON.stringify(payload);
  messages[0] = message;
  stdout.result.messages = messages;
  next.stdout = JSON.stringify(stdout);
  return replaceText(next, "task_e2eb775f72a6", reviewTask);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}

function rewriteComment(entry: TrackerFixture): TrackerFixture {
  if (entry.body === null) return entry;
  const parsed: unknown = JSON.parse(entry.body);
  const next = mapStrings(parsed, (text) =>
    text === droppedBody ? verdictBody : text,
  );
  return { ...entry, body: JSON.stringify(next) };
}

function rewriteRuns(text: string): string {
  let next = text;
  for (const id of otherRuns) next = next.replaceAll(id, runId);
  return next;
}

function filesOf(entries: readonly { name: string; text: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

export function compose(): {
  orca: { name: string; text: string }[];
  tracker: { name: string; text: string }[];
} {
  const lost = loadOrca("fixtures/orca/lost-launch-reply");
  const handoff = loadOrca("fixtures/orca/two-coordinator-handoff");
  const stale = loadOrca("fixtures/orca/stale-dispatch-id");
  const canceled = loadTracker("fixtures/tracker/tracker-canceled");
  const dropped = loadTracker("fixtures/tracker/tracker-dropped-reply");
  const taskCreate = one(lost, "task-create");
  const handoffChecks = checks(handoff);
  const staleChecks = checks(stale);
  const bridgeList = replaceText(
    one(handoff, "worker-list"),
    reviewTask,
    implementTask,
  );
  const reviewStart = replaceText(
    one(stale, "worker-start"),
    "task_e2eb775f72a6",
    reviewTask,
  );
  const reviewList = replaceText(
    one(stale, "worker-list"),
    "task_e2eb775f72a6",
    reviewTask,
  );
  const orcaEntries: OrcaFixture[] = [
    one(lost, "run-create"),
    taskCreate,
    replaceText(taskCreate, implementTask, reviewTask),
    replaceText(taskCreate, implementTask, "task_b768b145627f"),
    replaceText(taskCreate, implementTask, "task_e2eb775f72a6"),
    replaceText(taskCreate, implementTask, taskId(5)),
    replaceText(taskCreate, implementTask, taskId(6)),
    one(lost, "worker-start"),
    bridgeList,
    quietCheck(handoffChecks.open),
    one(handoff, "run-show"),
    one(handoff, "terminal-show"),
    one(handoff, "run-use"),
    handoffChecks.open,
    handoffChecks.ack,
    structuredClone(bridgeList),
    reviewStart,
    withHead(staleChecks.open),
    staleChecks.ack,
    reviewList,
    quietCheck(handoffChecks.open),
    emptyWorkers(one(handoff, "worker-list")),
    quietCheck(handoffChecks.open),
    emptyWorkers(one(handoff, "worker-list")),
    quietCheck(handoffChecks.open),
    emptyWorkers(one(handoff, "worker-list")),
    quietCheck(handoffChecks.open),
    emptyWorkers(one(handoff, "worker-list")),
  ];
  const comment = dropped.find((entry) => entry.body?.includes(droppedBody));
  const post = dropped.find((entry) => entry.method === "postComment");
  if (comment === undefined || post === undefined)
    throw new Error("dropped-reply fixtures are missing");
  const posted = structuredClone(post);
  posted.match.variables["bodyHash"] = sha256(verdictBody);
  const trackerEntries = [
    ...canceled,
    ...dropped.map((entry) => {
      if (entry === post) return posted;
      if (entry === comment) return rewriteComment(entry);
      return entry;
    }),
  ];
  const named = (index: number, verb: string) =>
    `${String(index + 1).padStart(3, "0")}-${verb}.json`;
  return {
    orca: orcaEntries.map((entry, index) => ({
      name: named(index, entry.verb),
      text: `${rewriteRuns(JSON.stringify(entry, null, 2))}\n`,
    })),
    tracker: trackerEntries.map((entry, index) => ({
      name: named(index, entry.method),
      text: `${JSON.stringify(entry, null, 2)}\n`,
    })),
  };
}

export function writeIntegrated(root = "."): void {
  const built = compose();
  const targets = [
    { dir: join(root, orcaDir), files: built.orca },
    { dir: join(root, trackerDir), files: built.tracker },
  ];
  for (const target of targets) {
    mkdirSync(target.dir, { recursive: true });
    const names = filesOf(target.files);
    for (const file of readdirSync(target.dir))
      if (!names.includes(file)) unlinkSync(join(target.dir, file));
    for (const file of target.files)
      writeFileSync(join(target.dir, file.name), file.text);
  }
}
