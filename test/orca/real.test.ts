import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  makeRealOrca,
  type RunOutput,
  type Runner,
} from "../../src/adapters/orca/real.ts";
import { makeScrubber } from "../../src/adapters/orca/scrub.ts";
import { launchOutcome } from "../../src/core/ledger/launch.ts";
import {
  OrcaVersionUnsupported,
  type ReceiptRecord,
} from "../../src/core/ports/orca.ts";

interface Call {
  file: string;
  args: readonly string[];
  killAfterMs: number | null;
}

function out(stdout: string, extra: Partial<RunOutput> = {}): RunOutput {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    spawnError: null,
    ...extra,
  };
}

function stub(
  reply: (args: readonly string[]) => RunOutput,
  version = "1.4.211",
): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (file, args, opts) => {
    calls.push({ file, args, killAfterMs: opts.killAfterMs });
    if (args[0] === "--version") return Promise.resolve(out(`${version}\n`));
    return Promise.resolve(reply(args));
  };
  return { run, calls };
}

function sinkInto(records: ReceiptRecord[]) {
  return (record: ReceiptRecord) => {
    records.push(record);
    return Promise.resolve();
  };
}

const ready = JSON.stringify({
  id: "r1",
  ok: true,
  result: {
    dispatchId: "ctx_1",
    state: "ready",
    taskId: "task_1",
    launch: { requested: { model: "m" }, effective: { model: "m" } },
    novel: { kept: true },
  },
  _meta: { runtimeId: "rt" },
});

test("a receipt record carries every field and the receipt keeps unknown fields in raw", async () => {
  const records: ReceiptRecord[] = [];
  const { run, calls } = stub(() => out(ready, { stderr: "note" }));
  const orca = makeRealOrca({ run, sink: sinkInto(records) });
  const receipt = await orca.workerStart({
    task: "task_1",
    run: "run_1",
    agent: "claude",
    model: "m",
    worktree: "current",
  });
  expect(receipt.verb).toBe("worker-start");
  expect(receipt.exitCode).toBe(0);
  expect(receipt.orcaVersion).toBe("1.4.211");
  expect(receipt.result?.dispatchId).toBe("ctx_1");
  expect(receipt.raw).toMatchObject({
    result: { novel: { kept: true } },
    _meta: { runtimeId: "rt" },
  });
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(Object.keys(record ?? {}).sort()).toEqual(
    [
      "argv",
      "endedAt",
      "exitCode",
      "orcaVersion",
      "signal",
      "startedAt",
      "stderr",
      "stdout",
      "verb",
    ].sort(),
  );
  expect(record).toMatchObject({
    verb: "worker-start",
    exitCode: 0,
    signal: null,
    stdout: ready,
    stderr: "note",
    orcaVersion: "1.4.211",
  });
  expect(record?.argv).toEqual([
    "orchestration",
    "worker-start",
    "--task",
    "task_1",
    "--run",
    "run_1",
    "--agent",
    "claude",
    "--model",
    "m",
    "--worktree",
    "current",
    "--json",
  ]);
  expect(calls.at(-1)?.file).toBe("orca");
  expect(launchOutcome(receipt)).toEqual({ kind: "ok" });
});

test("no call ever passes --terminal, and deps go as a JSON array", async () => {
  const { run, calls } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: { task: { id: "t", status: "pending" } },
      }),
    ),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  await orca.taskCreate({
    spec: "s",
    run: "run_1",
    deps: ["a", "b"],
    taskTitle: "x",
  });
  await orca.workerStart({ task: "t", agent: "claude", deps: ["a"] });
  await orca.workerStop({ dispatch: "d" });
  await orca.workerRelease({ dispatch: "d" });
  await orca.check({ run: "run_1" });
  await orca.send({ to: "h", subject: "s", body: "b" });
  await orca.requestShow({ request: "q" });
  await orca.workerList({ run: "run_1" });
  await orca.runUse({ run: "run_1" });
  await orca.runCreate({ objective: "o" });
  for (const call of calls) expect(call.args).not.toContain("--terminal");
  const create = calls.find((call) => call.args[1] === "task-create");
  expect(create?.args).toEqual([
    "orchestration",
    "task-create",
    "--spec",
    "s",
    "--run",
    "run_1",
    "--deps",
    '["a","b"]',
    "--task-title",
    "x",
    "--json",
  ]);
});

test("exit 1 with outcome_unknown is unknown and keeps the request id", async () => {
  const stateForm = JSON.stringify({
    ok: true,
    result: {
      state: "outcome_unknown",
      requestId: "11111111-1111-4111-8111-111111111111",
    },
  });
  const errorForm = JSON.stringify({
    ok: false,
    error: {
      code: "runtime_timeout",
      message: "timed out",
      data: {
        orchestrationRequestId: "22222222-2222-4222-8222-222222222222",
        recovery: { disposition: "outcome_unknown" },
      },
    },
  });
  for (const [stdout, id] of [
    [stateForm, "11111111-1111-4111-8111-111111111111"],
    [errorForm, "22222222-2222-4222-8222-222222222222"],
  ] as const) {
    const { run } = stub(() => out(stdout, { code: 1 }));
    const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
    const receipt = await orca.workerStart({ task: "t", agent: "claude" });
    expect(receipt.exitCode).toBe(1);
    expect(launchOutcome(receipt)).toEqual({ kind: "unknown", requestId: id });
  }
});

test("a lost reply is unknown with no request id", async () => {
  const cases: RunOutput[] = [
    out("Worker ctx_1 [ready]", { code: 0 }),
    out("", { code: null, signal: "SIGKILL" }),
    out("", { code: null, spawnError: "spawn orca ENOENT" }),
  ];
  const codes: number[] = [];
  for (const reply of cases) {
    const records: ReceiptRecord[] = [];
    const { run } = stub(() => reply);
    const orca = makeRealOrca({ run, sink: sinkInto(records) });
    const receipt = await orca.workerStart({ task: "t", agent: "claude" });
    expect(receipt.result).toBeNull();
    expect(receipt.raw).toBeNull();
    expect(launchOutcome(receipt)).toEqual({
      kind: "unknown",
      requestId: null,
    });
    codes.push(receipt.exitCode);
    if (reply.signal !== null) expect(records[0]?.signal).toBe("SIGKILL");
  }
  expect(codes).toEqual([0, 137, 127]);
});

test("a definite failure is failed", async () => {
  const { run } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: { state: "failed", lastError: "no agent" },
      }),
      {
        code: 1,
      },
    ),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const receipt = await orca.workerStart({ task: "t", agent: "claude" });
  expect(launchOutcome(receipt)).toEqual({ kind: "failed" });
});

test("the version gate refuses outside >=1.4.211 <1.5.0", async () => {
  for (const [version, accepted] of [
    ["1.4.210", false],
    ["1.4.211", true],
    ["1.4.240", true],
    ["1.5.0", false],
    ["orca", false],
  ] as const) {
    const { run, calls } = stub(
      () => out(JSON.stringify({ ok: true, result: { run: { id: "run_1" } } })),
      version,
    );
    const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
    const call = orca.runCreate({ objective: "o" });
    if (accepted) {
      await expect(call).resolves.toMatchObject({ orcaVersion: version });
    } else {
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OrcaVersionUnsupported);
      expect(error).toMatchObject({
        installed: version,
        range: ">=1.4.211 <1.5.0",
      });
      expect(calls.map((item) => item.args[0])).toEqual(["--version"]);
    }
  }
});

test("orca --version runs once per adapter", async () => {
  const { run, calls } = stub(() =>
    out(JSON.stringify({ ok: true, result: { run: { id: "run_1" } } })),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  await orca.version();
  await orca.runCreate({ objective: "o" });
  await orca.runCreate({ objective: "p" });
  expect(calls.filter((call) => call.args[0] === "--version")).toHaveLength(1);
});

test("record mode numbers files after existing ones and drops free text from match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-record-"));
  writeFileSync(join(dir, "004-run-create.json"), "{}");
  const { run, calls } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: { task: { id: "task_9", status: "ready" } },
      }),
    ),
  );
  const orca = makeRealOrca({
    run,
    sink: () => Promise.resolve(),
    record: {
      dir,
      kill: "worker-start",
      scrubber: makeScrubber({ hosts: [], users: [], roots: [], denylist: [] }),
    },
  });
  await orca.taskCreate({
    spec: "long text",
    run: "run_1",
    taskTitle: "build",
  });
  expect(calls.at(-1)?.killAfterMs).toBeNull();
  const files = readdirSync(dir).sort();
  expect(files).toEqual(["004-run-create.json", "005-task-create.json"]);
  const fixture = JSON.parse(
    readFileSync(join(dir, "005-task-create.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(fixture).toMatchObject({
    verb: "task-create",
    match: {
      argv: ["orchestration", "task-create", "--run", "run_1", "--json"],
    },
    exitCode: 0,
    signal: null,
    stderr: "",
    orcaVersion: "1.4.211",
  });
  expect(typeof fixture["recordedAt"]).toBe("string");
  await orca.workerStart({ task: "task_9", agent: "claude" }).catch(() => {});
  expect(calls.at(-1)?.killAfterMs).toBe(1500);
});

test("a fixture refused by the denylist does not fail the call, and is reported after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pod-record-"));
  const { run } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: { dispatchId: "ctx_1", state: "ready", note: "secretco" },
      }),
    ),
  );
  const records: ReceiptRecord[] = [];
  const orca = makeRealOrca({
    run,
    sink: sinkInto(records),
    record: {
      dir,
      kill: null,
      scrubber: makeScrubber({
        hosts: [],
        users: [],
        roots: [],
        denylist: ["secretco"],
      }),
    },
  });
  const receipt = await orca.workerStart({ task: "t", agent: "claude" });
  expect(launchOutcome(receipt)).toEqual({ kind: "ok" });
  expect(records).toHaveLength(1);
  expect(readdirSync(dir)).toEqual([]);
  expect(orca.recordRefusals()).toHaveLength(1);
  expect(orca.recordRefusals()[0]?.message).not.toContain("secretco");
});

function envelope(result: unknown): string {
  return JSON.stringify({
    id: "r",
    ok: true,
    result,
    _meta: { runtimeId: "rt" },
  });
}

test("a check batch parses string payloads, and an ack returns the next batch", async () => {
  const replies = [
    envelope({
      runId: "run_1",
      deliveryId: "delivery_1",
      messages: [
        {
          id: "msg_1",
          type: "worker_done",
          subject: "done",
          payload: JSON.stringify({
            taskId: "task_1",
            dispatchId: "ctx_1",
            outcome: "succeeded",
          }),
        },
        {
          id: "msg_2",
          type: "heartbeat",
          subject: "alive",
          payload: "not json",
        },
      ],
      count: 2,
      acknowledged: null,
    }),
    envelope({
      runId: "run_1",
      deliveryId: null,
      messages: [],
      count: 0,
      acknowledged: "delivery_1",
    }),
  ];
  const { run, calls } = stub(() => out(replies.shift() ?? ""));
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const batch = await orca.check({ run: "run_1" });
  expect(batch.result?.deliveryId).toBe("delivery_1");
  expect(batch.result?.messages.map((m) => m.payload)).toEqual([
    { taskId: "task_1", dispatchId: "ctx_1", outcome: "succeeded" },
    {},
  ]);
  const next = await orca.check({ run: "run_1", ack: "delivery_1" });
  expect(next.result).toMatchObject({
    messages: [],
    acknowledged: "delivery_1",
  });
  expect(calls.slice(1).map((call) => call.args)).toEqual([
    ["orchestration", "check", "--run", "run_1", "--json"],
    [
      "orchestration",
      "check",
      "--run",
      "run_1",
      "--ack",
      "delivery_1",
      "--json",
    ],
  ]);
});

test("worker-list takes the page flags and carries nextCursor", async () => {
  const { run, calls } = stub(() =>
    out(
      envelope({
        workers: [
          {
            dispatchId: "ctx_1",
            taskId: "task_1",
            workerState: "stopped",
            terminalState: "retained",
            resource: { worktreeId: "repo::/w" },
          },
        ],
        page: { limit: 1, total: 2, hasMore: true, nextCursor: "c2" },
      }),
    ),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const page = await orca.workerList({
    run: "run_1",
    terminalState: "active",
    cursor: "c1",
    limit: 1,
  });
  expect(page.result?.page.nextCursor).toBe("c2");
  expect(page.result?.workers[0]).toMatchObject({
    workerState: "stopped",
    resource: { worktreeId: "repo::/w" },
  });
  expect(calls[1]?.args).toEqual([
    "orchestration",
    "worker-list",
    "--run",
    "run_1",
    "--terminal-state",
    "active",
    "--cursor",
    "c1",
    "--limit",
    "1",
    "--json",
  ]);
});

test("worker-release parses each named state and leaves an unnamed one unparsed", async () => {
  const states = [
    "released",
    "already_released",
    "retained",
    "release_pending",
    "release_unknown",
    "novel_state",
  ];
  const replies = states.map((state) =>
    envelope({ dispatchId: "ctx_1", state, processAction: "none" }),
  );
  const { run } = stub(() => out(replies.shift() ?? ""));
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const parsed: (string | null)[] = [];
  while (parsed.length < states.length)
    parsed.push(
      (await orca.workerRelease({ dispatch: "ctx_1" })).result?.state ?? null,
    );
  expect(parsed).toEqual([...states.slice(0, 5), null]);
});

const orcaRun = {
  id: "run_1",
  objective: "o",
  coordinator_handle: "term_new",
  consumer_generation: 2,
  legacy: 0,
};

test("run-use names the coordinator terminal with --from and parses the Run", async () => {
  const { run, calls } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: {
          run: orcaRun,
          mutation: { requestId: "q1", replayed: false },
        },
      }),
    ),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const receipt = await orca.runUse({ run: "run_1", from: "term_new" });
  expect(calls[1]?.args).toEqual([
    "orchestration",
    "run-use",
    "--id",
    "run_1",
    "--from",
    "term_new",
    "--json",
  ]);
  expect(receipt.result?.run.consumer_generation).toBe(2);
  expect(receipt.result?.run.coordinator_handle).toBe("term_new");
});

test("run-show reads the Run's coordinator handle", async () => {
  const { run, calls } = stub(() =>
    out(JSON.stringify({ ok: true, result: { run: orcaRun } })),
  );
  const orca = makeRealOrca({ run, sink: () => Promise.resolve() });
  const receipt = await orca.runShow({ run: "run_1" });
  expect(calls[1]?.args).toEqual([
    "orchestration",
    "run-show",
    "--id",
    "run_1",
    "--json",
  ]);
  expect(receipt.verb).toBe("run-show");
  expect(receipt.result?.run.coordinator_handle).toBe("term_new");
});

test("terminal show is the terminal-show receipt verb", async () => {
  const records: ReceiptRecord[] = [];
  const { run, calls } = stub(() =>
    out(
      JSON.stringify({
        ok: true,
        result: {
          terminal: {
            handle: "term_old",
            connected: false,
            writable: false,
            exitCause: { kind: "operator_close" },
          },
        },
      }),
    ),
  );
  const orca = makeRealOrca({ run, sink: sinkInto(records) });
  const receipt = await orca.terminalShow({ terminal: "term_old" });
  expect(calls[1]?.args).toEqual([
    "terminal",
    "show",
    "--terminal",
    "term_old",
    "--json",
  ]);
  expect(receipt.verb).toBe("terminal-show");
  expect(records[0]?.verb).toBe("terminal-show");
  expect(receipt.result?.terminal).toMatchObject({
    connected: false,
    exitCause: { kind: "operator_close" },
  });
});
